(function (global) {
  'use strict';

  const CATEGORIES = ['비속어', '유행어', '외래어'];
  const SUGGESTION_TYPES = ['기존 표현으로 바꾸기', '새로운 말 만들기'];
  const PAGE_SIZE = 1000;
  let client = null;
  let initialized = false;

  function message(error) {
    const raw = error && error.message ? error.message : String(error || '요청을 처리하지 못했습니다.');
    if (/invalid login credentials/i.test(raw)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
    if (/anonymous sign-ins are disabled/i.test(raw)) return 'Supabase에서 익명 로그인을 활성화해 주세요.';
    if (/email not confirmed/i.test(raw)) return '계정의 이메일 인증을 먼저 완료해 주세요.';
    if (/failed to fetch|load failed|networkerror/i.test(raw)) return 'Supabase에 연결할 수 없습니다. 인터넷 연결과 프로젝트 설정을 확인해 주세요.';
    if (/row-level security|permission denied/i.test(raw)) return '이 작업을 수행할 권한이 없습니다.';
    return raw;
  }

  function fail(error) {
    throw new Error(message(error));
  }

  function check(result) {
    if (result.error) fail(result.error);
    return result.data;
  }

  function cleanText(value, maxLength) {
    return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, maxLength || 2000);
  }

  function requiredText(value, label, maxLength) {
    const text = cleanText(value, maxLength);
    if (!text) throw new Error(label + '을(를) 입력해 주세요.');
    return text;
  }

  function assertCategory(category) {
    if (!CATEGORIES.includes(String(category || ''))) throw new Error('유형을 올바르게 선택해 주세요.');
  }

  function assertRating(rating) {
    const value = Number(rating);
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('별점은 1~5점으로 입력해 주세요.');
    return value;
  }

  function normalizeWord(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[.!！?？,，。·~～…]+/g, '')
      .replace(/[ㅋㅎㅠㅜ]{2,}$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function average(numbers) {
    const valid = numbers.map(Number).filter(Number.isFinite);
    if (!valid.length) return 0;
    return Math.round((valid.reduce((sum, value) => sum + value, 0) / valid.length) * 10) / 10;
  }

  function groupBy(rows, key) {
    return rows.reduce((result, row) => {
      const value = String(row[key]);
      (result[value] ||= []).push(row);
      return result;
    }, Object.create(null));
  }

  function randomUuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const value = Math.random() * 16 | 0;
      return (character === 'x' ? value : (value & 3 | 8)).toString(16);
    });
  }

  async function fetchRows(table, columns, configure) {
    const all = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = client.from(table).select(columns || '*');
      if (configure) query = configure(query);
      const data = check(await query.range(offset, offset + PAGE_SIZE - 1));
      all.push(...data);
      if (data.length < PAGE_SIZE) return all;
    }
  }

  async function currentUser() {
    const result = await client.auth.getUser();
    if (result.error || !result.data.user) throw new Error('익명 식별 정보를 확인할 수 없습니다. 페이지를 새로고침해 주세요.');
    return result.data.user;
  }

  async function assertAdmin() {
    const sessionResult = await client.auth.getSession();
    if (sessionResult.error || !sessionResult.data.session) {
      throw new Error('관리자 인증이 만료되었습니다. 다시 로그인해 주세요.');
    }
    const isAdmin = check(await client.rpc('is_admin'));
    if (!isAdmin) throw new Error('관리자 인증이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.');
    return sessionResult.data.session;
  }

  async function assertTeacher() {
    const sessionResult = await client.auth.getSession();
    if (sessionResult.error || !sessionResult.data.session) {
      throw new Error('교사 인증이 만료되었습니다. 다시 로그인해 주세요.');
    }
    const isTeacher = check(await client.rpc('is_teacher'));
    if (!isTeacher) throw new Error('교사 인증이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.');
    return sessionResult.data.session;
  }

  async function assertClassManager(classId) {
    const id = requiredText(classId, '클래스', 80);
    const result = await client.auth.getSession();
    if (result.error || !result.data.session) throw new Error('교사 인증이 만료되었습니다. 다시 로그인해 주세요.');
    const allowed = check(await client.rpc('can_manage_class', { target_class_id: id }));
    if (!allowed) throw new Error('이 클래스를 관리할 권한이 없습니다.');
    return id;
  }

  function buildWordGroups(wordRows, ratingRows) {
    const words = wordRows.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const grouped = words.reduce((result, row) => {
      const key = String(row.class_id || '') + '\u0000' + String(row.normalized_word);
      (result[key] ||= []).push(row);
      return result;
    }, Object.create(null));
    const ratingsByWord = groupBy(ratingRows, 'word_id');
    return Object.keys(grouped).map(key => {
      const submissions = grouped[key];
      const representative = submissions[0];
      const latestByOwner = Object.create(null);
      submissions.forEach(submission => {
        (ratingsByWord[String(submission.id)] || []).forEach(rating => {
          latestByOwner[rating.owner_id] = Number(rating.rating);
        });
      });
      const scores = Object.values(latestByOwner);
      const categoryCounts = Object.create(null);
      submissions.forEach(row => {
        const category = CATEGORIES.includes(row.category) ? row.category : '유행어';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      });
      const category = CATEGORIES.slice().sort((a, b) => (categoryCounts[b] || 0) - (categoryCounts[a] || 0))[0];
      const mean = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
      const variance = scores.length ? scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length : 0;
      return {
        id: representative.id,
        classId: representative.class_id || '',
        word: representative.word,
        normalizedWord: representative.normalized_word,
        category,
        submissionCount: submissions.length,
        averageRating: Math.round(mean * 10) / 10,
        ratingCount: scores.length,
        ratingSpread: Math.round(Math.sqrt(variance) * 10) / 10,
        approved: submissions.some(row => Boolean(row.approved)),
        createdAt: representative.created_at,
        submitterOwnerIds: submissions.map(row => row.owner_id),
        ratingsByOwner: latestByOwner
      };
    }).sort((a, b) => b.submissionCount - a.submissionCount || String(a.word).localeCompare(String(b.word), 'ko'));
  }

  function publicAdminWord(word) {
    return {
      id: word.id,
      classId: word.classId,
      word: word.word,
      normalizedWord: word.normalizedWord,
      category: word.category,
      submissionCount: word.submissionCount,
      averageRating: word.averageRating,
      ratingCount: word.ratingCount,
      ratingSpread: word.ratingSpread,
      approved: word.approved,
      createdAt: word.createdAt
    };
  }

  function buildWordStats(words) {
    const stats = { total: words.length, '비속어': 0, '유행어': 0, '외래어': 0, ratingCount: 0 };
    words.forEach(word => {
      stats[word.category] = (stats[word.category] || 0) + 1;
      stats.ratingCount += word.ratingCount;
    });
    const rated = words.filter(word => word.ratingCount > 0);
    const take = list => list.slice(0, 5).map(word => ({ word: word.word, value: word.averageRating, count: word.ratingCount }));
    stats.highest = take(rated.slice().sort((a, b) => b.averageRating - a.averageRating));
    stats.lowest = take(rated.slice().sort((a, b) => a.averageRating - b.averageRating));
    stats.divisive = rated.slice().sort((a, b) => b.ratingSpread - a.ratingSpread).slice(0, 5)
      .map(word => ({ word: word.word, value: word.ratingSpread, count: word.ratingCount }));
    stats.frequent = words.slice().sort((a, b) => b.submissionCount - a.submissionCount).slice(0, 5)
      .map(word => ({ word: word.word, value: word.submissionCount, count: word.submissionCount }));
    return stats;
  }

  function publicTask(task) {
    return {
      id: task.id,
      classId: task.class_id || '',
      wordId: task.word_id,
      word: task.word,
      category: task.category,
      situation: task.situation,
      target: task.target,
      context: task.context,
      contextGroupId: task.context_group_id || task.id,
      contextTitle: task.context_title || task.target || '공통 맥락',
      active: Boolean(task.active),
      createdAt: task.created_at
    };
  }

  function taskSummaries(tasks, examples, ratings) {
    const examplesByTask = groupBy(examples, 'task_id');
    const ratingsByExample = groupBy(ratings, 'example_id');
    return tasks.map(task => {
      const taskExamples = examplesByTask[String(task.id)] || [];
      const scores = taskExamples.flatMap(example => (ratingsByExample[String(example.id)] || []).map(row => Number(row.rating)));
      return Object.assign(publicTask(task), {
        exampleCount: taskExamples.length,
        averageRating: average(scores),
        ratingCount: scores.length
      });
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function contextGroupSummaries(tasks, examples, ratings) {
    const summaries = taskSummaries(tasks, examples, ratings);
    const grouped = groupBy(summaries, 'contextGroupId');
    return Object.values(grouped).map(items => {
      const first = items[0];
      const scores = items.flatMap(item => {
        const taskExamples = examples.filter(example => String(example.task_id) === String(item.id));
        return taskExamples.flatMap(example => (ratings.filter(row => String(row.example_id) === String(example.id))).map(row => Number(row.rating)));
      });
      return {
        id: first.contextGroupId,
        title: first.contextTitle,
        context: first.context,
        active: items.some(item => item.active),
        words: items.map(item => ({
          taskId: item.id,
          wordId: item.wordId,
          word: item.word,
          category: item.category,
          exampleCount: item.exampleCount,
          averageRating: item.averageRating,
          ratingCount: item.ratingCount
        })),
        exampleCount: items.reduce((sum, item) => sum + item.exampleCount, 0),
        averageRating: average(scores),
        ratingCount: scores.length,
        createdAt: first.createdAt
      };
    }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function mapDictionary(row) {
    return {
      id: row.id,
      wordId: row.word_id,
      originalWord: row.original_word,
      category: row.category,
      finalWord: row.final_word,
      meaning: row.meaning,
      caution: row.caution,
      exampleSentence: row.example_sentence,
      approved: Boolean(row.approved),
      updatedAt: row.updated_at
    };
  }

  async function init(view) {
    if (initialized) return;
    const config = global.APP_CONFIG || {};
    const url = String(config.supabaseUrl || '').trim();
    const key = String(config.supabasePublishableKey || config.supabaseAnonKey || '').trim();
    if (!url || /YOUR_PROJECT|입력/i.test(url) || !key || /REPLACE|입력/i.test(key)) {
      throw new Error('앱의 데이터 저장소가 아직 연결되지 않았습니다. 관리자가 site/config.js에 Supabase 프로젝트 URL과 publishable 키를 설정해야 합니다.');
    }
    if (!global.supabase || !global.supabase.createClient) throw new Error('Supabase 라이브러리를 불러오지 못했습니다.');
    client = global.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: ['admin', 'teacher'].includes(view) ? global.sessionStorage : global.localStorage
      }
    });
    initialized = true;
    if (['teacher', 'student', 'submit', 'rate', 'context', 'wordmaking', 'dictionary'].includes(view)) {
      const session = await client.auth.getSession();
      if (session.error) fail(session.error);
      if (!session.data.session) check(await client.auth.signInAnonymously());
    }
  }

  async function getAdminToken() {
    const session = await client.auth.getSession();
    if (session.error || !session.data.session) return '';
    const result = await client.rpc('is_admin');
    if (result.error || !result.data) return '';
    return 'supabase-session';
  }

  async function verifyAdminCredentials(email, password) {
    const loginEmail = requiredText(email, '관리자 이메일', 320);
    const result = await client.auth.signInWithPassword({ email: loginEmail, password: String(password || '') });
    if (result.error) fail(result.error);
    const isAdmin = check(await client.rpc('is_admin'));
    if (!isAdmin) {
      await client.auth.signOut();
      throw new Error('이 계정에는 관리자 권한이 없습니다.');
    }
    return { token: 'supabase-session', expiresIn: result.data.session.expires_in };
  }

  function mapClass(row) {
    return {
      id: row.id,
      region: row.region,
      school: row.school,
      grade: row.grade,
      className: row.class_name,
      classCode: row.class_code,
      currentStage: row.current_stage,
      currentTaskId: row.current_task_id || '',
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function normalizeClassCode(value) {
    const code = cleanText(value, 12).replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      throw new Error('클래스 코드는 영문·숫자 4~12자리로 입력해 주세요.');
    }
    return code;
  }

  async function getTeacherToken() {
    const session = await client.auth.getSession();
    if (session.error || !session.data.session) return '';
    const result = await client.rpc('is_teacher');
    if (result.error || !result.data) return '';
    return 'supabase-session';
  }

  async function verifyTeacherCode(code) {
    const teacherCode = requiredText(code, '교사 코드', 80);
    const allowed = check(await client.rpc('claim_teacher_access', { p_code: teacherCode }));
    if (!allowed) throw new Error('교사 코드가 올바르지 않습니다.');
    return { token: 'supabase-session' };
  }

  async function getTeacherClasses() {
    await assertTeacher();
    const rows = await fetchRows('classes', '*', query => query.order('created_at'));
    return rows.map(mapClass);
  }

  async function createTeacherClass(_token, payload) {
    await assertTeacher();
    payload ||= {};
    const region = requiredText(payload.region, '지역', 80);
    const school = requiredText(payload.school, '학교명', 160);
    const grade = requiredText(payload.grade, '학년', 20);
    const className = requiredText(payload.className, '반', 40);
    const classCode = normalizeClassCode(payload.classCode);
    const recoveryHint = requiredText(payload.recoveryHint, '클래스 코드 찾기 힌트', 120);
    const result = await client.rpc('create_class', {
      p_region: region,
      p_school: school,
      p_grade: grade,
      p_class_name: className,
      p_class_code: classCode,
      p_recovery_hint: recoveryHint
    });
    if (result.error) {
      if (result.error.code === '23505' || /이미 사용 중|duplicate|unique/i.test(result.error.message || '')) {
        throw new Error('이미 사용 중인 클래스 코드입니다. 다른 코드를 입력해 주세요.');
      }
      fail(result.error);
    }
    if (!result.data || !result.data.length) throw new Error('클래스를 개설하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return mapClass(result.data[0]);
  }

  async function recoverTeacherClassCode(_token, payload) {
    await assertTeacher();
    payload ||= {};
    const result = await client.rpc('recover_class_code', {
      p_region: requiredText(payload.region, '지역', 80),
      p_school: requiredText(payload.school, '학교명', 160),
      p_grade: requiredText(payload.grade, '학년', 20),
      p_class_name: requiredText(payload.className, '반', 40),
      p_recovery_hint: requiredText(payload.recoveryHint, '클래스 코드 찾기 힌트', 120)
    });
    const rows = check(result) || [];
    return rows.map(row => ({
      classCode: row.class_code,
      region: row.region,
      school: row.school,
      grade: row.grade,
      className: row.class_name
    }));
  }

  async function enterTeacherClass(_token, classCode) {
    await assertTeacher();
    const code = normalizeClassCode(classCode);
    const rows = check(await client.rpc('enter_teacher_class', { p_code: code }));
    if (!rows || !rows.length) throw new Error('클래스 코드를 확인해 주세요.');
    return mapClass(rows[0]);
  }

  async function joinClass(classCode) {
    await currentUser();
    const code = normalizeClassCode(classCode);
    const rows = check(await client.rpc('join_class', { p_code: code }));
    if (!rows || !rows.length) throw new Error('클래스 코드를 확인해 주세요.');
    return mapClass(rows[0]);
  }

  async function getStudentClassState(classId) {
    await currentUser();
    const row = check(await client.from('classes').select('*').eq('id', classId).maybeSingle());
    if (!row) throw new Error('클래스 정보를 불러올 수 없습니다. 코드를 다시 입력해 주세요.');
    return mapClass(row);
  }

  async function setClassStage(_token, classId, stage, taskId) {
    const id = await assertClassManager(classId);
    const allowed = ['waiting', 'submit', 'rate', 'context', 'wordmaking', 'dictionary'];
    if (!allowed.includes(stage)) throw new Error('수업 단계를 올바르게 선택해 주세요.');
    const update = { current_stage: stage, current_task_id: stage === 'context' ? (taskId || null) : null };
    const row = check(await client.from('classes').update(update).eq('id', id).select('*').single());
    return mapClass(row);
  }

  async function getClassDashboard(_token, classId) {
    const id = await assertClassManager(classId);
    const [words, tasks] = await Promise.all([
      fetchRows('words', '*', query => query.eq('class_id', id).order('created_at')),
      fetchRows('context_tasks', '*', query => query.eq('class_id', id).order('created_at'))
    ]);
    const wordIds = words.map(item => item.id);
    const taskIds = tasks.map(item => item.id);
    const [wordRatings, examples, dictionary, pledges] = await Promise.all([
      wordIds.length ? fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [],
      taskIds.length ? fetchRows('context_examples', '*', query => query.in('task_id', taskIds)) : [],
      wordIds.length ? fetchRows('dictionary', '*', query => query.in('word_id', wordIds)) : [],
      fetchRows('class_pledges', '*', query => query.eq('class_id', id).order('created_at'))
    ]);
    const exampleIds = examples.map(item => item.id);
    const exampleRatings = exampleIds.length
      ? await fetchRows('example_ratings', '*', query => query.in('example_id', exampleIds))
      : [];
    const groups = buildWordGroups(words, wordRatings);
    return {
      words: groups.map(publicAdminWord),
      stats: buildWordStats(groups),
      tasks: taskSummaries(tasks, examples, exampleRatings),
      contextGroups: contextGroupSummaries(tasks, examples, exampleRatings),
      dictionaryCount: dictionary.filter(item => item.approved).length,
      pledges: pledges.map(row => ({ id: row.id, pledge: row.pledge, createdAt: row.created_at })),
      baseUrl: location.origin + location.pathname
    };
  }

  async function getAdminDashboard() {
    await assertAdmin();
    const [classes, words, wordRatings, tasks, examples, exampleRatings, dictionary] = await Promise.all([
      fetchRows('classes', '*', query => query.order('created_at', { ascending: false })),
      fetchRows('words', '*', query => query.order('created_at')),
      fetchRows('word_ratings'),
      fetchRows('context_tasks'),
      fetchRows('context_examples'),
      fetchRows('example_ratings'),
      fetchRows('dictionary')
    ]);
    const groups = buildWordGroups(words, wordRatings);
    return {
      classes: classes.map(mapClass),
      words: groups.map(publicAdminWord),
      stats: buildWordStats(groups),
      tasks: taskSummaries(tasks, examples, exampleRatings),
      contextGroups: contextGroupSummaries(tasks, examples, exampleRatings),
      dictionaryCount: dictionary.filter(item => item.approved).length,
      baseUrl: location.origin + location.pathname
    };
  }

  async function getAdminWords() {
    await assertAdmin();
    const [words, ratings] = await Promise.all([fetchRows('words'), fetchRows('word_ratings')]);
    const groups = buildWordGroups(words, ratings);
    return { words: groups.map(publicAdminWord), stats: buildWordStats(groups) };
  }

  async function updateWordGroup(_token, wordId, changes) {
    const target = check(await client.from('words').select('*').eq('id', wordId).maybeSingle());
    if (!target) throw new Error('해당 표현을 찾을 수 없습니다.');
    await assertClassManager(target.class_id);
    const update = {};
    if (changes && changes.category !== undefined) {
      assertCategory(changes.category);
      update.category = changes.category;
    }
    if (changes && changes.approved !== undefined) update.approved = Boolean(changes.approved);
    if (!Object.keys(update).length) return { ok: true, changed: 0 };
    const changed = check(await client.from('words').update(update).eq('class_id', target.class_id).eq('normalized_word', target.normalized_word).select('id'));
    return { ok: true, changed: changed.length };
  }

  async function deleteWordGroup(_token, wordId) {
    const target = check(await client.from('words').select('class_id,normalized_word').eq('id', wordId).maybeSingle());
    if (!target) throw new Error('해당 표현을 찾을 수 없습니다.');
    await assertClassManager(target.class_id);
    let deletion = client.from('words').delete().eq('normalized_word', target.normalized_word);
    deletion = target.class_id ? deletion.eq('class_id', target.class_id) : deletion.is('class_id', null);
    check(await deletion);
    return { ok: true };
  }

  async function submitWord(_anonId, word, category, classId) {
    const user = await currentUser();
    const targetClassId = requiredText(classId, '클래스', 80);
    assertCategory(category);
    const original = requiredText(word, '단어 또는 표현', 80);
    const normalized = normalizeWord(original);
    if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) throw new Error('문자나 숫자가 포함된 표현을 입력해 주세요.');
    const cutoff = new Date(Date.now() - 15000).toISOString();
    const recent = check(await client.from('words').select('id').eq('owner_id', user.id)
      .eq('class_id', targetClassId).eq('normalized_word', normalized).eq('category', category)
      .gte('created_at', cutoff).limit(1).maybeSingle());
    if (recent) return { ok: true, duplicatePrevented: true, id: recent.id };
    const saved = check(await client.from('words').insert({
      owner_id: user.id,
      class_id: targetClassId,
      word: original,
      normalized_word: normalized,
      category,
      approved: false
    }).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function getApprovedWords(_anonId, classId) {
    const user = await currentUser();
    const targetClassId = requiredText(classId, '클래스', 80);
    const words = await fetchRows('words', '*', query => query.eq('class_id', targetClassId).order('created_at'));
    const wordIds = words.map(item => item.id);
    const ratings = wordIds.length ? await fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [];
    return buildWordGroups(words, ratings).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      submissionCount: word.submissionCount,
      averageRating: word.averageRating,
      ratingCount: word.ratingCount,
      mine: word.submitterOwnerIds.includes(user.id),
      myRating: word.ratingsByOwner[user.id] || 0
    }));
  }

  async function saveWordRating(_anonId, wordId, rating) {
    const user = await currentUser();
    const score = assertRating(rating);
    const word = check(await client.from('words').select('id').eq('id', wordId).maybeSingle());
    if (!word) throw new Error('평가할 수 없는 표현입니다.');
    const existing = check(await client.from('word_ratings').select('id').eq('owner_id', user.id).eq('word_id', wordId).maybeSingle());
    const saved = check(await client.from('word_ratings').upsert({ owner_id: user.id, word_id: wordId, rating: score }, {
      onConflict: 'owner_id,word_id'
    }).select('id').single());
    return { ok: true, id: saved.id, updated: Boolean(existing) };
  }

  async function saveContextTask(_token, task) {
    task ||= {};
    const classId = await assertClassManager(task.classId);
    const situation = requiredText(task.situation, '상황', 500);
    const target = requiredText(task.target, '상대', 200);
    const context = requiredText(task.context, '맥락', 500);
    const words = await fetchRows('words', '*', query => query.eq('class_id', classId));
    const wordIds = words.map(item => item.id);
    const ratings = wordIds.length ? await fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [];
    const word = buildWordGroups(words, ratings).find(item => String(item.id) === String(task.wordId));
    if (!word) throw new Error('수집된 표현을 선택해 주세요.');
    const record = {
      word_id: word.id,
      class_id: classId,
      word: word.word,
      category: word.category,
      situation,
      target,
      context,
      active: task.active === undefined ? true : Boolean(task.active)
    };
    if (task.id) {
      const saved = check(await client.from('context_tasks').update(record).eq('id', task.id).select('id').maybeSingle());
      if (!saved) throw new Error('수정할 활동을 찾을 수 없습니다.');
      return { ok: true, id: saved.id };
    }
    const saved = check(await client.from('context_tasks').insert(record).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function saveContextGroup(_token, payload) {
    payload ||= {};
    const classId = await assertClassManager(payload.classId);
    const title = requiredText(payload.title, '맥락 이름', 120);
    const context = requiredText(payload.context, '공통 맥락', 500);
    const selectedIds = [...new Set((Array.isArray(payload.wordIds) ? payload.wordIds : []).map(String).filter(Boolean))];
    if (!selectedIds.length) throw new Error('이 맥락을 적용할 표현을 하나 이상 선택해 주세요.');
    const groupId = payload.groupId ? requiredText(payload.groupId, '맥락', 80) : randomUuid();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(groupId)) {
      throw new Error('맥락 식별 정보가 올바르지 않습니다.');
    }

    const wordRows = await fetchRows('words', '*', query => query.eq('class_id', classId));
    const ratingRows = wordRows.length
      ? await fetchRows('word_ratings', '*', query => query.in('word_id', wordRows.map(item => item.id)))
      : [];
    const words = buildWordGroups(wordRows, ratingRows);
    const selectedWords = selectedIds.map(id => words.find(item => String(item.id) === id)).filter(Boolean);
    if (selectedWords.length !== selectedIds.length) throw new Error('선택한 표현 중 이 클래스에 없는 항목이 있습니다.');

    const existingRows = await fetchRows('context_tasks', '*', query => query.eq('class_id', classId).eq('context_group_id', groupId));
    const selectedSet = new Set(selectedIds);
    const removedIds = existingRows.filter(row => !selectedSet.has(String(row.word_id))).map(row => row.id);
    const records = selectedWords.map(word => ({
        class_id: classId,
        context_group_id: groupId,
        context_title: title,
        word_id: word.id,
        word: word.word,
        category: word.category,
        situation: context,
        target: title,
        context,
        active: true
    }));
    check(await client.from('context_tasks').upsert(records, { onConflict: 'context_group_id,word_id' }));
    if (removedIds.length) check(await client.from('context_tasks').delete().in('id', removedIds));
    return { ok: true, id: groupId, wordCount: selectedWords.length };
  }

  async function deleteContextGroup(_token, groupId) {
    const id = requiredText(groupId, '맥락', 80);
    const task = check(await client.from('context_tasks').select('class_id').eq('context_group_id', id).limit(1).maybeSingle());
    if (!task) throw new Error('삭제할 맥락을 찾을 수 없습니다.');
    await assertClassManager(task.class_id);
    check(await client.from('context_tasks').delete().eq('context_group_id', id));
    return { ok: true };
  }

  async function getContextLesson(_anonId, classId) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const tasks = await fetchRows('context_tasks', '*', query => query.eq('class_id', id).eq('active', true).order('created_at'));
    const taskIds = tasks.map(item => item.id);
    const examples = taskIds.length
      ? await fetchRows('context_examples', '*', query => query.in('task_id', taskIds).order('created_at'))
      : [];
    const exampleIds = examples.map(item => item.id);
    const ratings = exampleIds.length
      ? await fetchRows('example_ratings', '*', query => query.in('example_id', exampleIds))
      : [];
    const examplesByTask = groupBy(examples, 'task_id');
    const ratingsByExample = groupBy(ratings, 'example_id');
    const groups = contextGroupSummaries(tasks, examples, ratings).map(group => ({
      id: group.id,
      title: group.title,
      context: group.context,
      words: group.words.map(word => {
        const rows = examplesByTask[String(word.taskId)] || [];
        const mine = rows.find(row => row.owner_id === user.id);
        return Object.assign({}, word, {
          submitted: Boolean(mine),
          ownResponse: mine ? { sentence: mine.sentence, intent: mine.intent || '' } : null,
          examples: rows.map(row => {
            const list = ratingsByExample[String(row.id)] || [];
            const ownRating = list.find(item => item.owner_id === user.id);
            return {
              id: row.id,
              sentence: row.sentence,
              intent: row.intent || '',
              mine: row.owner_id === user.id,
              myRating: ownRating ? Number(ownRating.rating) : 0,
              averageRating: average(list.map(item => item.rating)),
              ratingCount: list.length,
              createdAt: row.created_at
            };
          })
        });
      })
    }));
    return { groups };
  }

  async function deleteContextTask(_token, taskId) {
    const task = check(await client.from('context_tasks').select('class_id').eq('id', taskId).maybeSingle());
    if (!task) throw new Error('삭제할 활동을 찾을 수 없습니다.');
    await assertClassManager(task.class_id);
    const deleted = check(await client.from('context_tasks').delete().eq('id', taskId).select('id'));
    if (!deleted.length) throw new Error('삭제할 활동을 찾을 수 없습니다.');
    return { ok: true };
  }

  async function deleteClass(_token, classId) {
    await assertAdmin();
    const id = requiredText(classId, '클래스', 80);
    const deleted = check(await client.from('classes').delete().eq('id', id).select('id'));
    if (!deleted.length) throw new Error('삭제할 클래스를 찾을 수 없습니다.');
    return { ok: true };
  }

  async function getContextActivity(taskId) {
    const user = await currentUser();
    const task = check(await client.from('context_tasks').select('*').eq('id', taskId).eq('active', true).maybeSingle());
    if (!task) throw new Error('활동을 찾을 수 없거나 종료된 활동입니다.');
    const examples = await fetchRows('context_examples', '*', query => query.eq('task_id', taskId).order('created_at'));
    const ids = examples.map(item => item.id);
    const ratings = ids.length ? await fetchRows('example_ratings', '*', query => query.in('example_id', ids)) : [];
    const byExample = groupBy(ratings, 'example_id');
    return {
      task: publicTask(task),
      examples: examples.map(row => {
        const list = byExample[String(row.id)] || [];
        const ownRating = list.find(item => item.owner_id === user.id);
        return {
          id: row.id,
          sentence: row.sentence,
          intent: row.intent || '',
          createdAt: row.created_at,
          mine: row.owner_id === user.id,
          myRating: ownRating ? Number(ownRating.rating) : 0,
          averageRating: average(list.map(item => item.rating)),
          ratingCount: list.length
        };
      })
    };
  }

  async function submitContextExample(_anonId, taskId, sentence, intent) {
    const user = await currentUser();
    const text = requiredText(sentence, '예문', 800);
    const purpose = requiredText(intent, '문장을 만든 의도', 600);
    const task = check(await client.from('context_tasks').select('id').eq('id', taskId).eq('active', true).maybeSingle());
    if (!task) throw new Error('활동을 찾을 수 없거나 종료된 활동입니다.');
    const existing = check(await client.from('context_examples').select('id').eq('owner_id', user.id).eq('task_id', taskId).maybeSingle());
    const saved = check(await client.from('context_examples').upsert({ owner_id: user.id, task_id: taskId, sentence: text, intent: purpose }, {
      onConflict: 'owner_id,task_id'
    }).select('id').single());
    return { ok: true, id: saved.id, updated: Boolean(existing) };
  }

  async function saveExampleRating(_anonId, exampleId, rating) {
    const user = await currentUser();
    const score = assertRating(rating);
    const example = check(await client.from('context_examples').select('id,owner_id').eq('id', exampleId).maybeSingle());
    if (!example) throw new Error('평가할 예문을 찾을 수 없습니다.');
    if (example.owner_id === user.id) throw new Error('내 예문은 평가할 수 없습니다.');
    const existing = check(await client.from('example_ratings').select('id').eq('owner_id', user.id).eq('example_id', exampleId).maybeSingle());
    const saved = check(await client.from('example_ratings').upsert({ owner_id: user.id, example_id: exampleId, rating: score }, {
      onConflict: 'owner_id,example_id'
    }).select('id').single());
    return { ok: true, id: saved.id, updated: Boolean(existing) };
  }

  async function getContextResults(_token, taskId) {
    const task = check(await client.from('context_tasks').select('*').eq('id', taskId).maybeSingle());
    if (!task) throw new Error('활동을 찾을 수 없습니다.');
    await assertClassManager(task.class_id);
    const examples = await fetchRows('context_examples', '*', query => query.eq('task_id', taskId).order('created_at'));
    const ids = examples.map(item => item.id);
    const ratings = ids.length ? await fetchRows('example_ratings', '*', query => query.in('example_id', ids)) : [];
    const byExample = groupBy(ratings, 'example_id');
    return {
      task: publicTask(task),
      examples: examples.map(row => {
        const list = byExample[String(row.id)] || [];
        return {
          id: row.id,
          sentence: row.sentence,
          intent: row.intent || '',
          createdAt: row.created_at,
          averageRating: average(list.map(item => item.rating)),
          ratingCount: list.length
        };
      })
    };
  }

  async function getWordmakingWords(_anonId, classId) {
    const user = await currentUser();
    const targetClassId = requiredText(classId, '클래스', 80);
    const words = await fetchRows('words', '*', query => query.eq('class_id', targetClassId).eq('approved', true).order('created_at'));
    const wordIds = words.map(item => item.id);
    const [ratings, suggestions] = await Promise.all([
      wordIds.length ? fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('word_suggestions', '*', query => query.in('word_id', wordIds)) : []
    ]);
    const suggestionIds = suggestions.map(item => item.id);
    const suggestionRatings = suggestionIds.length
      ? await fetchRows('suggestion_ratings', '*', query => query.in('suggestion_id', suggestionIds))
      : [];
    const byWord = groupBy(suggestions, 'word_id');
    const ratingsBySuggestion = groupBy(suggestionRatings, 'suggestion_id');
    return buildWordGroups(words, ratings).filter(word => word.approved).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      submitted: (byWord[String(word.id)] || []).some(row => row.owner_id === user.id),
      suggestionCount: (byWord[String(word.id)] || []).length,
      ownSuggestion: (() => {
        const row = (byWord[String(word.id)] || []).find(item => item.owner_id === user.id);
        return row ? {
          id: row.id,
          suggestionType: row.suggestion_type,
          suggestedWord: row.suggested_word,
          reason: row.reason,
          exampleSentence: row.example_sentence
        } : null;
      })(),
      suggestions: (byWord[String(word.id)] || []).map(row => {
        const list = ratingsBySuggestion[String(row.id)] || [];
        const ownRating = list.find(item => item.owner_id === user.id);
        return {
          id: row.id,
          suggestedWord: row.suggested_word,
          reason: row.reason,
          mine: row.owner_id === user.id,
          myRating: ownRating ? Number(ownRating.rating) : 0,
          averageRating: average(list.map(item => item.rating)),
          ratingCount: list.length
        };
      }).sort((a, b) => b.averageRating - a.averageRating || b.ratingCount - a.ratingCount)
    }));
  }

  async function getWordmakingWorkspace(_token, classId) {
    const id = await assertClassManager(classId);
    const words = await fetchRows('words', '*', query => query.eq('class_id', id).order('created_at'));
    const wordIds = words.map(item => item.id);
    const [wordRatings, suggestions] = await Promise.all([
      wordIds.length ? fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('word_suggestions', '*', query => query.in('word_id', wordIds)) : []
    ]);
    const suggestionIds = suggestions.map(item => item.id);
    const suggestionRatings = suggestionIds.length
      ? await fetchRows('suggestion_ratings', '*', query => query.in('suggestion_id', suggestionIds))
      : [];
    const byWord = groupBy(suggestions, 'word_id');
    const ratingsBySuggestion = groupBy(suggestionRatings, 'suggestion_id');
    return buildWordGroups(words, wordRatings).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      approved: word.approved,
      averageRating: word.averageRating,
      ratingCount: word.ratingCount,
      suggestions: (byWord[String(word.id)] || []).map(row => {
        const list = ratingsBySuggestion[String(row.id)] || [];
        return {
          id: row.id,
          suggestedWord: row.suggested_word,
          reason: row.reason,
          averageRating: average(list.map(item => item.rating)),
          ratingCount: list.length,
          createdAt: row.created_at
        };
      }).sort((a, b) => b.averageRating - a.averageRating || b.ratingCount - a.ratingCount)
    }));
  }

  async function submitWordSuggestion(_anonId, payload) {
    const user = await currentUser();
    payload ||= {};
    const suggestionType = SUGGESTION_TYPES.includes(payload.suggestionType)
      ? payload.suggestionType
      : '새로운 말 만들기';
    const suggestedWord = requiredText(payload.suggestedWord, '바꾼 표현', 120);
    const reason = requiredText(payload.reason, '바꾼 이유', 600);
    const exampleSentence = cleanText(payload.exampleSentence, 800) || suggestedWord;
    const [words, ratings] = await Promise.all([
      fetchRows('words', '*', query => query.eq('approved', true).order('created_at')),
      fetchRows('word_ratings')
    ]);
    const word = buildWordGroups(words, ratings).find(item => String(item.id) === String(payload.wordId) && item.approved);
    if (!word) throw new Error('제안할 표현을 찾을 수 없습니다.');
    const existing = check(await client.from('word_suggestions').select('id').eq('owner_id', user.id).eq('word_id', word.id).maybeSingle());
    const saved = check(await client.from('word_suggestions').upsert({
      owner_id: user.id,
      word_id: word.id,
      original_word: word.word,
      category: word.category,
      suggestion_type: suggestionType,
      suggested_word: suggestedWord,
      reason,
      example_sentence: exampleSentence
    }, { onConflict: 'owner_id,word_id' }).select('id').single());
    return { ok: true, id: saved.id, updated: Boolean(existing) };
  }

  async function saveSuggestionRating(_anonId, suggestionId, rating) {
    const user = await currentUser();
    const score = assertRating(rating);
    const suggestion = check(await client.from('word_suggestions').select('id,owner_id').eq('id', suggestionId).maybeSingle());
    if (!suggestion) throw new Error('평가할 순화말을 찾을 수 없습니다.');
    if (suggestion.owner_id === user.id) throw new Error('내 순화말은 평가할 수 없습니다.');
    const existing = check(await client.from('suggestion_ratings').select('id').eq('owner_id', user.id).eq('suggestion_id', suggestionId).maybeSingle());
    const saved = check(await client.from('suggestion_ratings').upsert({
      owner_id: user.id,
      suggestion_id: suggestionId,
      rating: score
    }, { onConflict: 'owner_id,suggestion_id' }).select('id').single());
    return { ok: true, id: saved.id, updated: Boolean(existing) };
  }

  async function getDictionaryWorkspace(_token, classId) {
    let wordRows;
    if (classId) {
      const id = await assertClassManager(classId);
      wordRows = await fetchRows('words', '*', query => query.eq('class_id', id).order('created_at'));
    } else {
      await assertAdmin();
      wordRows = await fetchRows('words', '*', query => query.order('created_at'));
    }
    const wordIds = wordRows.map(item => item.id);
    const [ratings, suggestions, dictionary] = await Promise.all([
      wordIds.length ? fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('word_suggestions', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('dictionary', '*', query => query.in('word_id', wordIds)) : []
    ]);
    const suggestionIds = suggestions.map(item => item.id);
    const suggestionRatings = suggestionIds.length
      ? await fetchRows('suggestion_ratings', '*', query => query.in('suggestion_id', suggestionIds))
      : [];
    const byWord = groupBy(suggestions, 'word_id');
    const ratingsBySuggestion = groupBy(suggestionRatings, 'suggestion_id');
    const entryByWord = Object.create(null);
    dictionary.map(mapDictionary).forEach(entry => { entryByWord[String(entry.wordId)] = entry; });
    return buildWordGroups(wordRows, ratings).filter(word => word.approved).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      suggestions: (byWord[String(word.id)] || []).map(row => ({
        id: row.id,
        suggestionType: row.suggestion_type,
        suggestedWord: row.suggested_word,
        reason: row.reason,
        exampleSentence: row.example_sentence,
        averageRating: average((ratingsBySuggestion[String(row.id)] || []).map(item => item.rating)),
        ratingCount: (ratingsBySuggestion[String(row.id)] || []).length,
        createdAt: row.created_at
      })).sort((a, b) => b.averageRating - a.averageRating || b.ratingCount - a.ratingCount),
      entry: entryByWord[String(word.id)] || null
    }));
  }

  async function saveDictionaryEntry(_token, payload) {
    payload ||= {};
    const originalWord = requiredText(payload.originalWord, '원래 표현', 120);
    assertCategory(payload.category);
    const finalWord = cleanText(payload.finalWord, 160);
    const meaning = cleanText(payload.meaning, 1200);
    const caution = cleanText(payload.caution, 1200);
    const exampleSentence = cleanText(payload.exampleSentence, 1200);
    const approved = Boolean(payload.approved);
    if (approved && (!finalWord || !meaning)) throw new Error('사전에 등록하려면 최종 추천 표현과 뜻을 입력해 주세요.');
    const target = check(await client.from('words').select('class_id').eq('id', payload.wordId).maybeSingle());
    if (!target) throw new Error('승인된 원래 표현을 찾을 수 없습니다.');
    await assertClassManager(target.class_id);
    const words = await fetchRows('words', '*', query => query.eq('class_id', target.class_id));
    const wordIds = words.map(item => item.id);
    const ratings = wordIds.length ? await fetchRows('word_ratings', '*', query => query.in('word_id', wordIds)) : [];
    const word = buildWordGroups(words, ratings).find(item => String(item.id) === String(payload.wordId));
    if (!word || !word.approved) throw new Error('승인된 원래 표현을 찾을 수 없습니다.');
    const saved = check(await client.from('dictionary').upsert({
      word_id: word.id,
      original_word: originalWord,
      category: payload.category,
      final_word: finalWord,
      meaning,
      caution,
      example_sentence: exampleSentence,
      approved,
      updated_at: new Date().toISOString()
    }, { onConflict: 'word_id' }).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function getPublishedDictionary(_anonId, classId) {
    await currentUser();
    const words = await fetchRows('words', 'id', query => query.eq('class_id', requiredText(classId, '클래스', 80)));
    const wordIds = words.map(item => item.id);
    const rows = wordIds.length
      ? await fetchRows('dictionary', '*', query => query.in('word_id', wordIds).eq('approved', true).order('original_word'))
      : [];
    return rows.map(mapDictionary);
  }

  async function getClassPledges(_anonId, classId) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const rows = await fetchRows('class_pledges', '*', query => query.eq('class_id', id).order('created_at'));
    return rows.map(row => ({
      id: row.id,
      pledge: row.pledge,
      mine: row.owner_id === user.id,
      createdAt: row.created_at
    }));
  }

  async function saveClassPledge(_anonId, classId, pledge) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const text = requiredText(pledge, '나의 다짐', 500);
    const saved = check(await client.from('class_pledges').upsert({
      class_id: id,
      owner_id: user.id,
      pledge: text
    }, { onConflict: 'class_id,owner_id' }).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function deleteClassPledge(_token, pledgeId) {
    const pledge = check(await client.from('class_pledges').select('id,class_id').eq('id', pledgeId).maybeSingle());
    if (!pledge) throw new Error('삭제할 다짐을 찾을 수 없습니다.');
    await assertClassManager(pledge.class_id);
    check(await client.from('class_pledges').delete().eq('id', pledge.id));
    return { ok: true };
  }

  const methods = {
    verifyAdminCredentials,
    verifyTeacherCode,
    getTeacherClasses,
    createTeacherClass,
    recoverTeacherClassCode,
    enterTeacherClass,
    joinClass,
    getStudentClassState,
    setClassStage,
    getClassDashboard,
    getAdminDashboard,
    getAdminWords,
    updateWordGroup,
    deleteWordGroup,
    submitWord,
    getApprovedWords,
    saveWordRating,
    saveContextTask,
    saveContextGroup,
    deleteContextGroup,
    getContextLesson,
    deleteContextTask,
    deleteClass,
    getContextActivity,
    submitContextExample,
    saveExampleRating,
    getContextResults,
    getWordmakingWords,
    getWordmakingWorkspace,
    submitWordSuggestion,
    saveSuggestionRating,
    getDictionaryWorkspace,
    saveDictionaryEntry,
    getPublishedDictionary,
    getClassPledges,
    saveClassPledge,
    deleteClassPledge
  };

  global.AppApi = Object.freeze({
    init,
    getAdminToken,
    getTeacherToken,
    async signOut() {
      if (!client) return;
      const result = await client.auth.signOut();
      if (result.error) fail(result.error);
    },
    async call(name, ...args) {
      if (!initialized) throw new Error('Supabase 연결이 초기화되지 않았습니다.');
      if (!Object.prototype.hasOwnProperty.call(methods, name)) throw new Error('지원하지 않는 API 요청입니다: ' + name);
      return methods[name](...args);
    }
  });
})(window);
