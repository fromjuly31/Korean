(function (global) {
  'use strict';

  const CATEGORIES = ['유행어', '신조어'];
  const SUGGESTION_TYPES = ['기존 표현으로 바꾸기', '새로운 말 만들기'];
  const PAGE_SIZE = 1000;
  let client = null;
  let initialized = false;
  let apiUrl = '';
  let apiKey = '';
  let accessToken = '';

  function message(error) {
    const raw = error && error.message ? error.message : String(error || '요청을 처리하지 못했습니다.');
    if (/invalid login credentials/i.test(raw)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
    if (/anonymous sign-ins are disabled/i.test(raw)) return 'Supabase에서 익명 로그인을 활성화해 주세요.';
    if (/email not confirmed/i.test(raw)) return '계정의 이메일 인증을 먼저 완료해 주세요.';
    if (/failed to fetch|load failed|networkerror/i.test(raw)) return 'Supabase에 연결할 수 없습니다. 인터넷 연결과 프로젝트 설정을 확인해 주세요.';
    if (/row-level security|permission denied/i.test(raw)) return '이 작업을 수행할 권한이 없습니다.';
    if ((error && error.code === '23505') || /duplicate key|unique constraint/i.test(raw)) return '이미 평가한 항목입니다.';
    const missingSchemaObject = (error && ['PGRST202', 'PGRST204', 'PGRST205'].includes(error.code))
      || /schema cache|could not find the (table|function|column)/i.test(raw);
    if (missingSchemaObject && /reset_class_results|usability_responses/i.test(raw)) {
      return '기존 클래스 기능 업데이트가 필요합니다. Supabase에서 permissions-update.sql을 먼저 실행해 주세요.';
    }
    if (missingSchemaObject) {
      return '수업 기능 업데이트가 필요합니다. Supabase에서 lesson-flow-update.sql을 한 번 실행해 주세요.';
    }
    if (error && error.code && !/[가-힣]/.test(raw)) return '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.';
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
    return String(value || '').trim();
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

  async function getStudentUuid() {
    return (await currentUser()).id;
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
    const [teacherResult, adminResult] = await Promise.all([client.rpc('is_teacher'), client.rpc('is_admin')]);
    const isTeacher = check(teacherResult);
    const isAdmin = check(adminResult);
    if (!isTeacher && !isAdmin) throw new Error('교사 인증이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.');
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

  function buildWordGroups(wordRows, ratingRows, sourceRows) {
    const words = wordRows.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const grouped = words.reduce((result, row) => {
      const key = String(row.class_id || '') + '\u0000' + String(row.normalized_word);
      (result[key] ||= []).push(row);
      return result;
    }, Object.create(null));
    const ratingsByWord = groupBy(ratingRows, 'word_id');
    const sourcesByWord = groupBy(sourceRows || [], 'word_id');
    return Object.keys(grouped).map(key => {
      const submissions = grouped[key];
      const representative = submissions[0];
      const latestByOwner = Object.create(null);
      const sourceCounts = Object.create(null);
      const sourceOrder = [];
      submissions.forEach(submission => {
        (ratingsByWord[String(submission.id)] || []).forEach(rating => {
          latestByOwner[rating.owner_id] = Number(rating.rating);
        });
        (sourcesByWord[String(submission.id)] || []).forEach(entry => {
          const source = cleanText(entry.source, 200);
          if (!source) return;
          if (!sourceCounts[source]) sourceOrder.push(source);
          sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        });
      });
      const scores = Object.values(latestByOwner);
      const categoryCounts = Object.create(null);
      submissions.forEach(row => {
        const category = CATEGORIES.includes(row.category) ? row.category : '유행어';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      });
      const category = CATEGORIES.slice().sort((a, b) => (categoryCounts[b] || 0) - (categoryCounts[a] || 0))[0];
      const sources = sourceOrder.map((text, index) => ({ text, count: sourceCounts[text], index }))
        .sort((a, b) => b.count - a.count || a.index - b.index)
        .map(({ text, count }) => ({ text, count }));
      const submissionCount = submissions.reduce((sum, row) => sum + Math.max(1, Number(row.submit_count) || 1), 0);
      const attributedSourceCount = sources.reduce((sum, item) => sum + item.count, 0);
      const mean = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
      const variance = scores.length ? scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length : 0;
      return {
        id: representative.id,
        classId: representative.class_id || '',
        word: representative.word,
        normalizedWord: representative.normalized_word,
        category,
        submissionCount,
        averageRating: Math.round(mean * 10) / 10,
        ratingCount: scores.length,
        ratingSpread: Math.round(Math.sqrt(variance) * 10) / 10,
        approved: submissions.some(row => Boolean(row.approved)),
        createdAt: representative.created_at,
        submitterOwnerIds: submissions.map(row => row.owner_id),
        ratingsByOwner: latestByOwner,
        representativeSource: sources[0] ? sources[0].text : '',
        sources,
        unattributedSourceCount: Math.max(0, submissionCount - attributedSourceCount)
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
      createdAt: word.createdAt,
      representativeSource: word.representativeSource,
      sources: word.sources,
      unattributedSourceCount: word.unattributedSourceCount
    };
  }

  function buildWordStats(words) {
    const stats = { total: words.length, '유행어': 0, '신조어': 0, ratingCount: 0 };
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

  function usabilityTaskSummaries(tasks, responses) {
    return tasks.map(task => {
      const rows = responses.filter(row => String(row.test_id) === String(task.id));
      return Object.assign(publicTask(task), {
        averageRating: average(rows.map(row => row.score)),
        ratingCount: rows.length,
        responseCount: rows.length
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
      suggestionId: row.suggestion_id || '',
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
    apiUrl = url;
    apiKey = key;
    client = global.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: ['admin', 'teacher'].includes(view) ? global.sessionStorage : global.localStorage
      }
    });
    initialized = true;
    client.auth.onAuthStateChange((_event, session) => {
      accessToken = session && session.access_token ? session.access_token : '';
    });
    if (['teacher', 'student', 'submit', 'rate', 'context', 'wordmaking', 'dictionary'].includes(view)) {
      const sessionResult = await client.auth.getSession();
      if (sessionResult.error) fail(sessionResult.error);
      let session = sessionResult.data.session;
      if (!session) {
        const signIn = check(await client.auth.signInAnonymously());
        session = signIn && signIn.session;
      }
      accessToken = session && session.access_token ? session.access_token : '';
    }
  }

  async function fetchWordSources(configure) {
    try {
      return await fetchRows('word_sources', '*', configure);
    } catch (error) {
      // 정적 화면이 먼저 배포된 경우에도 기존 수업 자료 조회는 유지합니다.
      // 새 출처 저장은 submit_word RPC에서 DB 업데이트 안내와 함께 중단됩니다.
      if (/lesson-flow-update\.sql/i.test(String(error && error.message || ''))) return [];
      throw error;
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
      discussionTopic: row.discussion_topic || '',
      diagnosticWordCapacity: Math.max(1, Number(row.diagnostic_word_capacity) || 4),
      usageTrackingEnabled: Boolean(row.usage_tracking_enabled),
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
    const [teacherResult, adminResult] = await Promise.all([client.rpc('is_teacher'), client.rpc('is_admin')]);
    if (teacherResult.error || adminResult.error || (!teacherResult.data && !adminResult.data)) return '';
    return 'supabase-session';
  }

  async function verifyTeacherCode(code) {
    const teacherCode = requiredText(code, '교사 비밀번호', 80);
    const allowed = check(await client.rpc('claim_teacher_access', { p_code: teacherCode }));
    if (!allowed) throw new Error('교사 비밀번호가 올바르지 않습니다.');
    return { token: 'supabase-session' };
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
    const row = check(await client.from('classes').select('*').eq('id', rows[0].id).maybeSingle());
    return mapClass(row || rows[0]);
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
    const allowed = ['waiting', 'opinion', 'submit', 'rate', 'context', 'wordmaking', 'dictionary'];
    if (!allowed.includes(stage)) throw new Error('수업 단계를 올바르게 선택해 주세요.');
    const update = { current_stage: stage, current_task_id: stage === 'context' ? (taskId || null) : null };
    const row = check(await client.from('classes').update(update).eq('id', id).select('*').single());
    return mapClass(row);
  }

  async function getClassDashboard(_token, classId) {
    const id = await assertClassManager(classId);
    const [classRow, words, wordSources, tasks, opinionRows] = await Promise.all([
      client.from('classes').select('id,discussion_topic').eq('id', id).maybeSingle().then(check),
      fetchRows('words', '*', query => query.eq('class_id', id).order('created_at')),
      fetchWordSources(query => query.eq('class_id', id).order('created_at')),
      fetchRows('context_tasks', '*', query => query.eq('class_id', id).order('created_at')),
      fetchRows('opinion_responses', '*', query => query.eq('class_id', id).order('created_at'))
    ]);
    const wordIds = words.map(item => item.id);
    const taskIds = tasks.map(item => item.id);
    const [dictionary, usabilityResponses] = await Promise.all([
      wordIds.length ? fetchRows('dictionary', '*', query => query.in('word_id', wordIds).eq('approved', true)) : [],
      taskIds.length ? fetchRows('usability_responses', '*', query => query.in('test_id', taskIds)) : []
    ]);
    const groups = buildWordGroups(words, [], wordSources);
    return {
      words: groups.map(publicAdminWord),
      discussion: buildOpinionDiscussion(classRow, opinionRows),
      stats: buildWordStats(groups),
      tasks: usabilityTaskSummaries(tasks, usabilityResponses),
      dictionaryCount: dictionary.filter(item => item.approved).length,
      baseUrl: location.origin + location.pathname
    };
  }

  function mapOpinionResponse(row) {
    return {
      id: row.id,
      classId: row.class_id,
      choice: row.choice,
      reason: row.reason,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at
    };
  }

  function buildOpinionDiscussion(classRow, rows, userId) {
    const responses = (rows || []).map(mapOpinionResponse);
    return {
      topic: classRow && classRow.discussion_topic || '',
      responses,
      agreeCount: responses.filter(item => item.choice === 'agree').length,
      disagreeCount: responses.filter(item => item.choice === 'disagree').length,
      myResponse: userId ? (responses.find(item => item.ownerId === userId) || null) : null
    };
  }

  async function getOpinionWorkspace(_token, classId) {
    const id = await assertClassManager(classId);
    const [classRow, rows] = await Promise.all([
      client.from('classes').select('id,discussion_topic').eq('id', id).maybeSingle().then(check),
      fetchRows('opinion_responses', '*', query => query.eq('class_id', id).order('created_at'))
    ]);
    if (!classRow) throw new Error('클래스를 찾을 수 없습니다.');
    return buildOpinionDiscussion(classRow, rows);
  }

  async function getOpinionLesson(_anonId, classId) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const [classRow, rows] = await Promise.all([
      client.from('classes').select('id,discussion_topic').eq('id', id).maybeSingle().then(check),
      fetchRows('opinion_responses', '*', query => query.eq('class_id', id).eq('owner_id', user.id))
    ]);
    if (!classRow) throw new Error('클래스를 찾을 수 없습니다.');
    return buildOpinionDiscussion(classRow, rows, user.id);
  }

  async function startOpinionDiscussion(_token, classId, topic) {
    const id = await assertClassManager(classId);
    const cleanTopic = requiredText(topic, '생각 나누기 주제', 300);
    check(await client.rpc('start_opinion_discussion', { p_class_id: id, p_topic: cleanTopic }));
    const [classRow, discussion] = await Promise.all([
      client.from('classes').select('*').eq('id', id).single().then(check),
      getOpinionWorkspace(_token, id)
    ]);
    return { classInfo: mapClass(classRow), discussion };
  }

  async function submitOpinionResponse(_anonId, classId, choice, reason) {
    await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const selected = String(choice || '').toLowerCase();
    if (!['agree', 'disagree'].includes(selected)) throw new Error('찬성 또는 반대를 선택해 주세요.');
    const cleanReason = requiredText(reason, '선택한 이유', 500);
    const rows = check(await client.rpc('submit_opinion_response', {
      p_class_id: id,
      p_choice: selected,
      p_reason: cleanReason
    })) || [];
    return { ok: true, id: rows[0] ? rows[0].response_id : '' };
  }

  async function getClassWords(_token, classId) {
    const id = requiredText(classId, '클래스', 80);
    const [words, wordSources] = await Promise.all([
      fetchRows('words', '*', query => query.eq('class_id', id).order('created_at')),
      fetchWordSources(query => query.eq('class_id', id).order('created_at'))
    ]);
    return buildWordGroups(words, [], wordSources).map(publicAdminWord);
  }

  async function getAdminDashboard() {
    await assertAdmin();
    const [classes, words, wordSources, tasks, dictionary, usabilityResponses] = await Promise.all([
      fetchRows('classes', '*', query => query.order('created_at', { ascending: false })),
      fetchRows('words', '*', query => query.order('created_at')),
      fetchWordSources(query => query.order('created_at')),
      fetchRows('context_tasks'),
      fetchRows('dictionary'),
      fetchRows('usability_responses')
    ]);
    const groups = buildWordGroups(words, [], wordSources);
    return {
      classes: classes.map(mapClass),
      words: groups.map(publicAdminWord),
      stats: buildWordStats(groups),
      tasks: usabilityTaskSummaries(tasks, usabilityResponses),
      dictionaryCount: dictionary.filter(item => item.approved).length,
      baseUrl: location.origin + location.pathname
    };
  }

  async function getAdminWords() {
    await assertAdmin();
    const [words, ratings, wordSources] = await Promise.all([fetchRows('words'), fetchRows('word_ratings'), fetchWordSources()]);
    const groups = buildWordGroups(words, ratings, wordSources);
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

  async function submitWord(_anonId, word, category, source, classId) {
    await currentUser();
    const targetClassId = requiredText(classId, '클래스', 80);
    assertCategory(category);
    const original = requiredText(word, '단어 또는 표현', 80);
    const collectionSource = requiredText(source, '수집 출처', 200);
    const normalized = normalizeWord(original);
    if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) throw new Error('문자나 숫자가 포함된 표현을 입력해 주세요.');
    const rows = check(await client.rpc('submit_word', {
      p_class_id: targetClassId,
      p_word: original,
      p_category: category,
      p_source: collectionSource
    }));
    const saved = rows && rows[0];
    if (!saved) throw new Error('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return { ok: true, id: saved.id, submissionCount: saved.submit_count, merged: Boolean(saved.duplicate) };
  }

  async function getApprovedWords(_anonId, classId) {
    const user = await currentUser();
    const targetClassId = requiredText(classId, '클래스', 80);
    const [words, wordSources] = await Promise.all([
      fetchRows('words', '*', query => query.eq('class_id', targetClassId).order('created_at')),
      fetchWordSources(query => query.eq('class_id', targetClassId).order('created_at'))
    ]);
    return buildWordGroups(words, [], wordSources).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      submissionCount: word.submissionCount,
      averageRating: word.averageRating,
      ratingCount: word.ratingCount,
      representativeSource: word.representativeSource,
      sources: word.sources,
      unattributedSourceCount: word.unattributedSourceCount,
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

  function mapUsabilityTest(task, responses, userId) {
    const rows = responses.filter(row => String(row.test_id) === String(task.id));
    const mine = rows.find(row => row.owner_id === userId);
    return {
      id: task.id,
      classId: task.class_id,
      wordId: task.word_id,
      word: task.word,
      category: task.category,
      situation: task.situation,
      audience: task.target,
      purpose: task.context,
      active: Boolean(task.active),
      myScore: mine ? Number(mine.score) : 0,
      averageScore: average(rows.map(row => row.score)),
      responseCount: rows.length,
      createdAt: task.created_at
    };
  }

  function mapDiagnosticCard(card, word) {
    return {
      id: card.id,
      classId: card.class_id,
      wordId: card.word_id,
      word: word ? word.word : '',
      category: word ? word.category : '유행어',
      status: card.status || 'draft',
      complete: card.status === 'complete',
      dimensions: Array.isArray(card.dimensions) ? card.dimensions : [],
      appropriate: {
        partner: card.appropriate_partner || '',
        place: card.appropriate_place || '',
        situation: card.appropriate_situation || '',
        example: card.appropriate_example || '',
        rating: Number(card.appropriate_rating) || 0
      },
      inappropriate: {
        partner: card.inappropriate_partner || '',
        place: card.inappropriate_place || '',
        situation: card.inappropriate_situation || '',
        example: card.inappropriate_example || '',
        rating: Number(card.inappropriate_rating) || 0
      },
      ratingReason: card.rating_reason || '',
      ownerId: card.owner_id,
      createdAt: card.created_at,
      updatedAt: card.updated_at
    };
  }

  async function diagnosticData(classId, manager) {
    const id = manager ? await assertClassManager(classId) : requiredText(classId, '클래스', 80);
    const user = manager ? null : await currentUser();
    const [classRow, wordRows, cardRows] = await Promise.all([
      client.from('classes').select('id,diagnostic_word_capacity').eq('id', id).maybeSingle().then(check),
      fetchRows('words', '*', query => query.eq('class_id', id).order('created_at')),
      fetchRows('diagnostic_cards', '*', query => query.eq('class_id', id).order('created_at'))
    ]);
    if (!classRow) throw new Error('클래스를 찾을 수 없습니다.');
    const words = buildWordGroups(wordRows, []);
    const wordById = Object.fromEntries(words.map(word => [String(word.id), word]));
    const cards = cardRows.map(card => mapDiagnosticCard(card, wordById[String(card.word_id)])).filter(card => card.word);
    const selectedByWord = cards.reduce((counts, card) => {
      counts[String(card.wordId)] = (counts[String(card.wordId)] || 0) + 1;
      return counts;
    }, Object.create(null));
    const capacity = Math.max(1, Number(classRow.diagnostic_word_capacity) || 4);
    return {
      capacity,
      words: words.map(word => {
        const selectedCount = selectedByWord[String(word.id)] || 0;
        return {
          id: word.id,
          word: word.word,
          category: word.category,
          submissionCount: word.submissionCount,
          selectedCount,
          remainingCount: Math.max(0, capacity - selectedCount),
          full: selectedCount >= capacity
        };
      }),
      cards,
      myCard: user ? (cards.find(card => card.ownerId === user.id) || null) : null
    };
  }

  async function getDiagnosticLesson(_anonId, classId) {
    return diagnosticData(classId, false);
  }

  async function getDiagnosticWorkspace(_token, classId) {
    return diagnosticData(classId, true);
  }

  async function setDiagnosticCapacity(_token, classId, capacity) {
    const id = await assertClassManager(classId);
    const value = Number(capacity);
    if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('표현별 선택 인원은 1~50명으로 설정해 주세요.');
    const row = check(await client.from('classes').update({
      diagnostic_word_capacity: value,
      updated_at: new Date().toISOString()
    }).eq('id', id).select('id,diagnostic_word_capacity').maybeSingle());
    if (!row) throw new Error('선택 인원 설정을 저장하지 못했습니다.');
    return { ok: true, capacity: Number(row.diagnostic_word_capacity) };
  }

  async function claimDiagnosticWord(_anonId, classId, wordId) {
    await currentUser();
    const result = check(await client.rpc('claim_diagnostic_word', {
      p_class_id: requiredText(classId, '클래스', 80),
      p_word_id: requiredText(wordId, '표현', 80)
    }));
    if (!result || !result.length) throw new Error('표현을 선택하지 못했습니다.');
    return { ok: true, id: result[0].card_id };
  }

  async function saveDiagnosticCard(_anonId, payload) {
    await currentUser();
    payload ||= {};
    const dimensions = [...new Set((Array.isArray(payload.dimensions) ? payload.dimensions : []).filter(value => ['partner', 'place', 'situation'].includes(value)))];
    if (dimensions.length < 2) throw new Error('대화 상대, 장소, 상황 중 두 가지 이상을 선택해 주세요.');
    const appropriate = payload.appropriate || {};
    const inappropriate = payload.inappropriate || {};
    const result = check(await client.rpc('save_diagnostic_card', {
      p_card_id: requiredText(payload.cardId, '진단 카드', 80),
      p_dimensions: dimensions,
      p_appropriate_partner: cleanText(appropriate.partner, 200),
      p_appropriate_place: cleanText(appropriate.place, 200),
      p_appropriate_situation: cleanText(appropriate.situation, 500),
      p_appropriate_example: requiredText(appropriate.example, '적절한 경우의 예문', 800),
      p_appropriate_rating: assertRating(appropriate.rating),
      p_inappropriate_partner: cleanText(inappropriate.partner, 200),
      p_inappropriate_place: cleanText(inappropriate.place, 200),
      p_inappropriate_situation: cleanText(inappropriate.situation, 500),
      p_inappropriate_example: requiredText(inappropriate.example, '그렇지 않은 경우의 예문', 800),
      p_inappropriate_rating: assertRating(inappropriate.rating),
      p_rating_reason: requiredText(payload.ratingReason, '평가 이유', 800)
    }));
    return { ok: true, id: result && result[0] ? result[0].card_id : payload.cardId };
  }

  async function getUsabilityLesson(_anonId, classId) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const tasks = await fetchRows('context_tasks', '*', query => query.eq('class_id', id).eq('active', true).order('created_at'));
    const taskIds = tasks.map(item => item.id);
    const responses = taskIds.length
      ? await fetchRows('usability_responses', '*', query => query.in('test_id', taskIds))
      : [];
    return { tests: tasks.map(task => mapUsabilityTest(task, responses, user.id)) };
  }

  async function getUsabilityWorkspace(_token, classId) {
    const id = await assertClassManager(classId);
    const tasks = await fetchRows('context_tasks', '*', query => query.eq('class_id', id).order('created_at'));
    const taskIds = tasks.map(item => item.id);
    const responses = taskIds.length
      ? await fetchRows('usability_responses', '*', query => query.in('test_id', taskIds))
      : [];
    return { tests: tasks.map(task => mapUsabilityTest(task, responses, '')) };
  }

  async function saveUsabilityResponse(_anonId, testId, score) {
    const user = await currentUser();
    const rating = assertRating(score);
    const existing = check(await client.from('usability_responses').select('id')
      .eq('test_id', testId).eq('owner_id', user.id).maybeSingle());
    if (existing) throw new Error('이미 평가한 항목입니다.');
    const saved = check(await client.from('usability_responses').insert({
      test_id: testId,
      owner_id: user.id,
      score: rating
    }).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function setUsabilityTestActive(_token, testId, active) {
    const task = check(await client.from('context_tasks').select('id,class_id').eq('id', testId).maybeSingle());
    if (!task) throw new Error('사용성 테스트를 찾을 수 없습니다.');
    await assertClassManager(task.class_id);
    const saved = check(await client.from('context_tasks').update({ active: Boolean(active) }).eq('id', task.id).select('id').maybeSingle());
    if (!saved) throw new Error('테스트 상태를 변경하지 못했습니다.');
    return { ok: true };
  }

  async function deleteClass(_token, classId) {
    await assertAdmin();
    const id = requiredText(classId, '클래스', 80);
    const deleted = check(await client.from('classes').delete().eq('id', id).select('id'));
    if (!deleted.length) throw new Error('삭제할 클래스를 찾을 수 없습니다.');
    return { ok: true };
  }

  async function resetClassResults(_token, classId) {
    const id = await assertClassManager(classId);
    const result = check(await client.rpc('reset_class_results', { p_class_id: id }));
    if (!result) throw new Error('수업 결과를 초기화하지 못했습니다.');
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

  function summarizeRedesignReviews(rows) {
    const meaningScore = average(rows.map(item => item.meaning_score));
    const naturalScore = average(rows.map(item => item.natural_score));
    const universalScore = average(rows.map(item => item.universal_score));
    const clarityScore = average(rows.map(item => item.clarity_score == null ? item.memorable_score : item.clarity_score));
    return {
      meaningScore,
      naturalScore,
      universalScore,
      clarityScore,
      overallScore: rows.length ? average([meaningScore, naturalScore, universalScore, clarityScore]) : 0,
      reviewCount: rows.length
    };
  }

  function summarizeUsabilityByWord(tasks, responses) {
    const responsesByTest = groupBy(responses, 'test_id');
    const tasksByWord = groupBy(tasks, 'word_id');
    const result = Object.create(null);
    Object.keys(tasksByWord).forEach(wordId => {
      const scenarioAverages = [];
      const allScores = [];
      tasksByWord[wordId].forEach(task => {
        const scores = (responsesByTest[String(task.id)] || []).map(row => Number(row.score));
        if (scores.length) {
          scenarioAverages.push(average(scores));
          allScores.push(...scores);
        }
      });
      const rangeScore = scenarioAverages.length > 1
        ? Math.max(...scenarioAverages) - Math.min(...scenarioAverages)
        : 0;
      result[wordId] = {
        averageScore: average(allScores),
        responseCount: allScores.length,
        situationCount: tasksByWord[wordId].length,
        rangeScore,
        rangeLabel: scenarioAverages.length < 2 ? '판단 대기' : rangeScore < 0.8 ? '좁음' : rangeScore < 1.6 ? '보통' : '넓음'
      };
    });
    return result;
  }

  async function getWordmakingWords(_anonId, classId) {
    const user = await currentUser();
    const targetClassId = requiredText(classId, '클래스', 80);
    const words = await fetchRows('words', '*', query => query.eq('class_id', targetClassId).order('created_at'));
    const wordIds = words.map(item => item.id);
    const [suggestions, usabilityTasks] = await Promise.all([
      wordIds.length ? fetchRows('word_suggestions', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('context_tasks', '*', query => query.in('word_id', wordIds)) : []
    ]);
    const usabilityTaskIds = usabilityTasks.map(item => item.id);
    const usabilityResponses = usabilityTaskIds.length
      ? await fetchRows('usability_responses', '*', query => query.in('test_id', usabilityTaskIds))
      : [];
    const suggestionIds = suggestions.map(item => item.id);
    const suggestionRatings = suggestionIds.length
      ? await fetchRows('suggestion_ratings', '*', query => query.in('suggestion_id', suggestionIds))
      : [];
    const byWord = groupBy(suggestions, 'word_id');
    const ratingsBySuggestion = groupBy(suggestionRatings, 'suggestion_id');
    const usabilityByWord = summarizeUsabilityByWord(usabilityTasks, usabilityResponses);
    return buildWordGroups(words, []).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      usability: usabilityByWord[String(word.id)] || { averageScore: 0, responseCount: 0, situationCount: 0, rangeScore: 0, rangeLabel: '판단 대기' },
      submitted: (byWord[String(word.id)] || []).some(row => row.owner_id === user.id),
      suggestionCount: (byWord[String(word.id)] || []).length,
      ownSuggestion: (() => {
        const row = (byWord[String(word.id)] || []).find(item => item.owner_id === user.id);
        return row ? {
          id: row.id,
          suggestionType: row.suggestion_type,
          meaning: row.meaning || row.example_sentence || '',
          coreFeature: row.core_feature || '',
          suggestedWord: row.suggested_word,
          reason: row.reason,
          exampleSentence: row.example_sentence
        } : null;
      })(),
      suggestions: (byWord[String(word.id)] || []).map(row => {
        const list = ratingsBySuggestion[String(row.id)] || [];
        const ownRating = list.find(item => item.owner_id === user.id);
        return Object.assign({
          id: row.id,
          originalWord: row.original_word,
          meaning: row.meaning || row.example_sentence || '',
          coreFeature: row.core_feature || '',
          suggestedWord: row.suggested_word,
          reason: row.reason,
          mine: row.owner_id === user.id,
          reviewed: Boolean(ownRating),
          myReview: ownRating ? {
            meaningScore: Number(ownRating.meaning_score),
            naturalScore: Number(ownRating.natural_score),
            universalScore: Number(ownRating.universal_score),
            clarityScore: Number(ownRating.clarity_score == null ? ownRating.memorable_score : ownRating.clarity_score)
          } : null
        }, summarizeRedesignReviews(list));
      }).sort((a, b) => b.overallScore - a.overallScore || b.reviewCount - a.reviewCount)
    }));
  }

  async function getWordmakingWorkspace(_token, classId) {
    const id = await assertClassManager(classId);
    const words = await fetchRows('words', '*', query => query.eq('class_id', id).order('created_at'));
    const wordIds = words.map(item => item.id);
    const [suggestions, usabilityTasks] = await Promise.all([
      wordIds.length ? fetchRows('word_suggestions', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('context_tasks', '*', query => query.in('word_id', wordIds)) : []
    ]);
    const usabilityTaskIds = usabilityTasks.map(item => item.id);
    const usabilityResponses = usabilityTaskIds.length
      ? await fetchRows('usability_responses', '*', query => query.in('test_id', usabilityTaskIds))
      : [];
    const suggestionIds = suggestions.map(item => item.id);
    const suggestionRatings = suggestionIds.length
      ? await fetchRows('suggestion_ratings', '*', query => query.in('suggestion_id', suggestionIds))
      : [];
    const byWord = groupBy(suggestions, 'word_id');
    const ratingsBySuggestion = groupBy(suggestionRatings, 'suggestion_id');
    const usabilityByWord = summarizeUsabilityByWord(usabilityTasks, usabilityResponses);
    return buildWordGroups(words, []).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      submissionCount: word.submissionCount,
      approved: word.approved,
      averageRating: word.averageRating,
      ratingCount: word.ratingCount,
      usability: usabilityByWord[String(word.id)] || { averageScore: 0, responseCount: 0, situationCount: 0, rangeScore: 0, rangeLabel: '판단 대기' },
      suggestions: (byWord[String(word.id)] || []).map(row => {
        const list = ratingsBySuggestion[String(row.id)] || [];
        return Object.assign({
          id: row.id,
          meaning: row.meaning || row.example_sentence || '',
          coreFeature: row.core_feature || '',
          suggestedWord: row.suggested_word,
          reason: row.reason,
          createdAt: row.created_at
        }, summarizeRedesignReviews(list));
      }).sort((a, b) => b.overallScore - a.overallScore || b.reviewCount - a.reviewCount)
    }));
  }

  async function redesignData(classId, manager) {
    const id = manager ? await assertClassManager(classId) : requiredText(classId, '클래스', 80);
    const user = manager ? null : await currentUser();
    const [wordRows, cardRows] = await Promise.all([
      fetchRows('words', '*', query => query.eq('class_id', id).order('created_at')),
      fetchRows('diagnostic_cards', '*', query => query.eq('class_id', id).eq('status', 'complete').order('updated_at'))
    ]);
    const words = buildWordGroups(wordRows, []);
    const wordById = Object.fromEntries(words.map(word => [String(word.id), word]));
    const cardIds = cardRows.map(card => card.id);
    const suggestions = cardIds.length
      ? await fetchRows('word_suggestions', '*', query => query.in('diagnostic_card_id', cardIds).order('created_at'))
      : [];
    const suggestionsByCard = groupBy(suggestions, 'diagnostic_card_id');
    return cardRows.map(row => {
      const card = mapDiagnosticCard(row, wordById[String(row.word_id)]);
      const linked = (suggestionsByCard[String(row.id)] || []).map(suggestion => ({
        id: suggestion.id,
        wordId: suggestion.word_id,
        diagnosticCardId: suggestion.diagnostic_card_id,
        originalWord: suggestion.original_word,
        suggestedWord: suggestion.suggested_word,
        meaning: suggestion.meaning || '',
        coreFeature: suggestion.core_feature || '',
        reason: suggestion.reason || '',
        exampleSentence: suggestion.example_sentence || '',
        mine: user ? suggestion.owner_id === user.id : false,
        createdAt: suggestion.created_at
      }));
      card.suggestions = linked;
      card.submitted = user ? linked.some(suggestion => suggestion.mine) : false;
      return card;
    }).filter(card => card.word);
  }

  async function getRedesignLesson(_anonId, classId) {
    return redesignData(classId, false);
  }

  async function getRedesignWorkspace(_token, classId) {
    return redesignData(classId, true);
  }

  async function submitDiagnosticRedesign(_anonId, payload) {
    await currentUser();
    payload ||= {};
    const suggestedWord = requiredText(payload.suggestedWord, '새 표현', 120);
    const meaning = requiredText(payload.meaning, '새 표현의 뜻', 600);
    const reason = requiredText(payload.reason, '바꾼 이유', 600);
    const exampleSentence = requiredText(payload.exampleSentence, '새 예문', 800);
    const rows = check(await client.rpc('submit_diagnostic_redesign', {
      p_card_id: requiredText(payload.diagnosticCardId, '진단 카드', 80),
      p_suggested_word: suggestedWord,
      p_meaning: meaning,
      p_reason: reason,
      p_example_sentence: exampleSentence
    })) || [];
    if (!rows.length) throw new Error('새 표현을 저장하지 못했습니다.');
    return { ok: true, id: rows[0].suggestion_id, testId: rows[0].test_id };
  }

  async function submitWordSuggestion(_anonId, payload) {
    const user = await currentUser();
    payload ||= {};
    const suggestionType = SUGGESTION_TYPES.includes(payload.suggestionType)
      ? payload.suggestionType
      : '새로운 말 만들기';
    const meaning = requiredText(payload.meaning, '이 말이 전달하려는 의미', 600);
    const coreFeature = requiredText(payload.coreFeature, '핵심 특징', 600);
    const suggestedWord = requiredText(payload.suggestedWord, '바꾼 표현', 120);
    const reason = requiredText(payload.reason, '바꾼 이유', 600);
    const exampleSentence = meaning;
    const words = await fetchRows('words', '*', query => query.order('created_at'));
    const word = buildWordGroups(words, []).find(item => String(item.id) === String(payload.wordId));
    if (!word) throw new Error('제안할 표현을 찾을 수 없습니다.');
    const existing = check(await client.from('word_suggestions').select('id').eq('owner_id', user.id).eq('word_id', word.id).maybeSingle());
    if (existing) throw new Error('이 표현에는 이미 리디자인 제안을 등록했습니다.');
    const saved = check(await client.from('word_suggestions').insert({
      owner_id: user.id,
      word_id: word.id,
      original_word: word.word,
      category: word.category,
      suggestion_type: suggestionType,
      meaning,
      core_feature: coreFeature,
      suggested_word: suggestedWord,
      reason,
      example_sentence: exampleSentence
    }).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function saveSuggestionReview(_anonId, suggestionId, scores) {
    const user = await currentUser();
    scores ||= {};
    const meaningScore = assertRating(scores.meaningScore);
    const naturalScore = assertRating(scores.naturalScore);
    const universalScore = assertRating(scores.universalScore);
    const clarityScore = assertRating(scores.clarityScore);
    const suggestion = check(await client.from('word_suggestions').select('id,owner_id').eq('id', suggestionId).maybeSingle());
    if (!suggestion) throw new Error('평가할 리디자인 제안을 찾을 수 없습니다.');
    if (suggestion.owner_id === user.id) throw new Error('내 제안은 평가할 수 없습니다.');
    const existing = check(await client.from('suggestion_ratings').select('id').eq('owner_id', user.id).eq('suggestion_id', suggestionId).maybeSingle());
    if (existing) throw new Error('이미 평가한 항목입니다.');
    const overall = Math.round(((meaningScore + naturalScore + universalScore + clarityScore) / 4) * 10) / 10;
    const saved = check(await client.from('suggestion_ratings').insert({
      owner_id: user.id,
      suggestion_id: suggestionId,
      rating: Math.round(overall),
      meaning_score: meaningScore,
      natural_score: naturalScore,
      universal_score: universalScore,
      clarity_score: clarityScore,
      memorable_score: clarityScore
    }).select('id').single());
    return { ok: true, id: saved.id, overallScore: overall };
  }

  async function deleteWordSuggestion(_token, suggestionId) {
    const suggestion = check(await client.from('word_suggestions').select('id,word_id').eq('id', suggestionId).maybeSingle());
    if (!suggestion) throw new Error('삭제할 리디자인 제안을 찾을 수 없습니다.');
    const word = check(await client.from('words').select('class_id').eq('id', suggestion.word_id).maybeSingle());
    if (!word) throw new Error('원래 표현을 찾을 수 없습니다.');
    await assertClassManager(word.class_id);
    check(await client.from('word_suggestions').delete().eq('id', suggestion.id));
    return { ok: true };
  }

  const AB_CHOICES = ['A', 'SAME', 'B'];
  const AB_FIELDS = {
    clarity: 'clarity_choice',
    natural: 'natural_choice',
    universal: 'universal_choice',
    usage: 'usage_choice'
  };

  function summarizeAbResponses(rows) {
    const metrics = {};
    Object.keys(AB_FIELDS).forEach(key => {
      const field = AB_FIELDS[key];
      const counts = { A: 0, SAME: 0, B: 0 };
      rows.forEach(row => { if (AB_CHOICES.includes(row[field])) counts[row[field]] += 1; });
      const total = counts.A + counts.SAME + counts.B;
      metrics[key] = {
        a: counts.A,
        same: counts.SAME,
        b: counts.B,
        aPercent: total ? Math.round(counts.A / total * 100) : 0,
        samePercent: total ? Math.round(counts.SAME / total * 100) : 0,
        bPercent: total ? Math.round(counts.B / total * 100) : 0
      };
    });
    const improvementScore = rows.length
      ? Math.round(average(Object.values(metrics).map(item => item.bPercent - item.aPercent)))
      : 0;
    return { responseCount: rows.length, improvementScore, metrics };
  }

  async function getAbTestLesson(_anonId, classId) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const tests = await fetchRows('ab_tests', '*', query => query.eq('class_id', id).eq('active', true).order('created_at'));
    const testIds = tests.map(item => item.id);
    const wordIds = [...new Set(tests.map(item => item.word_id))];
    const suggestionIds = [...new Set(tests.map(item => item.suggestion_id))];
    const [words, suggestions, responses] = await Promise.all([
      wordIds.length ? fetchRows('words', '*', query => query.in('id', wordIds)) : [],
      suggestionIds.length ? fetchRows('word_suggestions', '*', query => query.in('id', suggestionIds)) : [],
      testIds.length ? fetchRows('ab_responses', '*', query => query.in('ab_test_id', testIds)) : []
    ]);
    const wordById = Object.fromEntries(words.map(row => [String(row.id), row]));
    const suggestionById = Object.fromEntries(suggestions.map(row => [String(row.id), row]));
    const responsesByTest = groupBy(responses, 'ab_test_id');
    const mapped = tests.map(test => {
      const word = wordById[String(test.word_id)];
      const suggestion = suggestionById[String(test.suggestion_id)];
      const list = responsesByTest[String(test.id)] || [];
      if (!word || !suggestion) return null;
      return Object.assign({
        id: test.id,
        wordId: word.id,
        suggestionId: suggestion.id,
        category: word.category,
        originalWord: word.word,
        redesignedWord: suggestion.suggested_word,
        meaning: suggestion.meaning || suggestion.example_sentence || '',
        myResponse: Boolean(list.find(row => row.owner_id === user.id))
      }, summarizeAbResponses(list));
    }).filter(Boolean);
    return { tests: mapped, completedCount: mapped.filter(item => item.myResponse).length };
  }

  async function saveAbResponse(_anonId, testId, answers) {
    const user = await currentUser();
    answers ||= {};
    const values = {};
    Object.keys(AB_FIELDS).forEach(key => {
      const value = String(answers[key] || '').toUpperCase();
      if (!AB_CHOICES.includes(value)) throw new Error('네 가지 비교 항목을 모두 선택해 주세요.');
      values[AB_FIELDS[key]] = value;
    });
    const existing = check(await client.from('ab_responses').select('id').eq('ab_test_id', testId).eq('owner_id', user.id).maybeSingle());
    if (existing) throw new Error('이미 응답한 비교입니다.');
    const saved = check(await client.from('ab_responses').insert(Object.assign({
      ab_test_id: testId,
      owner_id: user.id
    }, values)).select('id').single());
    return { ok: true, id: saved.id };
  }

  async function saveComparisonVote(_anonId, testId, choice) {
    await currentUser();
    const value = String(choice || '').toUpperCase();
    if (!['A', 'B'].includes(value)) throw new Error('기존 표현과 새 표현 중 하나를 선택해 주세요.');
    const rows = check(await client.rpc('submit_comparison_vote', {
      p_test_id: requiredText(testId, '비교', 80),
      p_choice: value
    })) || [];
    const result = rows[0] || {};
    return {
      ok: true,
      winner: result.winner || '',
      originalVotes: Number(result.original_votes) || 0,
      redesignVotes: Number(result.redesign_votes) || 0
    };
  }

  async function saveAbTest(_token, suggestionId) {
    const suggestion = check(await client.from('word_suggestions').select('id,word_id').eq('id', suggestionId).maybeSingle());
    if (!suggestion) throw new Error('검증할 리디자인 제안을 찾을 수 없습니다.');
    const word = check(await client.from('words').select('id,class_id').eq('id', suggestion.word_id).maybeSingle());
    if (!word) throw new Error('원래 표현을 찾을 수 없습니다.');
    await assertClassManager(word.class_id);
    const existing = check(await client.from('ab_tests').select('id').eq('suggestion_id', suggestion.id).maybeSingle());
    if (existing) {
      check(await client.from('ab_tests').update({ active: true }).eq('id', existing.id));
      return { ok: true, id: existing.id, updated: true };
    }
    const saved = check(await client.from('ab_tests').insert({
      class_id: word.class_id,
      word_id: word.id,
      suggestion_id: suggestion.id,
      active: true
    }).select('id').single());
    return { ok: true, id: saved.id, updated: false };
  }

  async function setAbTestActive(_token, testId, active) {
    const test = check(await client.from('ab_tests').select('id,class_id').eq('id', testId).maybeSingle());
    if (!test) throw new Error('검증 항목을 찾을 수 없습니다.');
    await assertClassManager(test.class_id);
    check(await client.from('ab_tests').update({ active: Boolean(active) }).eq('id', test.id));
    return { ok: true };
  }

  async function deleteAbTest(_token, testId) {
    const test = check(await client.from('ab_tests').select('id,class_id').eq('id', testId).maybeSingle());
    if (!test) throw new Error('삭제할 검증 항목을 찾을 수 없습니다.');
    await assertClassManager(test.class_id);
    check(await client.from('ab_tests').delete().eq('id', test.id));
    return { ok: true };
  }

  function currentWeekStart() {
    const date = new Date();
    const day = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - day);
    return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
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
    const [suggestions, dictionary, abTests] = await Promise.all([
      wordIds.length ? fetchRows('word_suggestions', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('dictionary', '*', query => query.in('word_id', wordIds)) : [],
      wordIds.length ? fetchRows('ab_tests', '*', query => query.in('word_id', wordIds)) : []
    ]);
    const abTestIds = abTests.map(item => item.id);
    const dictionaryIds = dictionary.map(item => item.id);
    const [abResponses, usageLogs] = await Promise.all([
      abTestIds.length ? fetchRows('ab_responses', '*', query => query.in('ab_test_id', abTestIds)) : [],
      dictionaryIds.length ? fetchRows('dictionary_usage_logs', '*', query => query.in('dictionary_id', dictionaryIds).eq('week_start', currentWeekStart())) : []
    ]);
    const byWord = groupBy(suggestions, 'word_id');
    const abTestBySuggestion = Object.fromEntries(abTests.map(row => [String(row.suggestion_id), row]));
    const responsesByTest = groupBy(abResponses, 'ab_test_id');
    const usageByDictionary = groupBy(usageLogs, 'dictionary_id');
    const entryByWord = Object.create(null);
    dictionary.map(mapDictionary).forEach(entry => {
      entry.usageCount = (usageByDictionary[String(entry.id)] || []).length;
      entryByWord[String(entry.wordId)] = entry;
    });
    return buildWordGroups(wordRows, []).map(word => ({
      id: word.id,
      word: word.word,
      category: word.category,
      suggestions: (byWord[String(word.id)] || []).map(row => {
        const test = abTestBySuggestion[String(row.id)];
        return Object.assign({
          id: row.id,
          suggestionType: row.suggestion_type,
          meaning: row.meaning || row.example_sentence || '',
          coreFeature: row.core_feature || '',
          suggestedWord: row.suggested_word,
          reason: row.reason,
          exampleSentence: row.example_sentence,
          createdAt: row.created_at,
          abTest: test ? Object.assign({ id: test.id, active: Boolean(test.active) }, summarizeAbResponses(responsesByTest[String(test.id)] || [])) : null
        }, summarizeRedesignReviews([]));
      }).sort((a, b) => Number(b.abTest && b.abTest.improvementScore || -999) - Number(a.abTest && a.abTest.improvementScore || -999) || b.overallScore - a.overallScore),
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
    if (!target) throw new Error('원래 표현을 찾을 수 없습니다.');
    await assertClassManager(target.class_id);
    const words = await fetchRows('words', '*', query => query.eq('class_id', target.class_id));
    const word = buildWordGroups(words, []).find(item => String(item.id) === String(payload.wordId));
    if (!word) throw new Error('원래 표현을 찾을 수 없습니다.');
    const saved = check(await client.from('dictionary').upsert({
      word_id: word.id,
      suggestion_id: payload.suggestionId || null,
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

  async function setUsageTrackingEnabled(_token, classId, enabled) {
    const id = await assertClassManager(classId);
    const saved = check(await client.from('classes').update({
      usage_tracking_enabled: Boolean(enabled),
      updated_at: new Date().toISOString()
    }).eq('id', id).select('id,usage_tracking_enabled').maybeSingle());
    if (!saved) throw new Error('실제 사용 기록 설정을 바꾸지 못했습니다.');
    return { ok: true, enabled: Boolean(saved.usage_tracking_enabled) };
  }

  async function getPublishedDictionary(_anonId, classId) {
    const user = await currentUser();
    const id = requiredText(classId, '클래스', 80);
    const classRow = check(await client.from('classes').select('id,usage_tracking_enabled').eq('id', id).maybeSingle());
    const words = await fetchRows('words', 'id', query => query.eq('class_id', id));
    const wordIds = words.map(item => item.id);
    const rows = wordIds.length
      ? await fetchRows('dictionary', '*', query => query.in('word_id', wordIds).eq('approved', true).order('original_word'))
      : [];
    const dictionaryIds = rows.map(item => item.id);
    const ownUsage = dictionaryIds.length
      ? await fetchRows('dictionary_usage_logs', '*', query => query.in('dictionary_id', dictionaryIds).eq('owner_id', user.id).eq('week_start', currentWeekStart()))
      : [];
    const usedIds = new Set(ownUsage.map(row => String(row.dictionary_id)));
    return {
      usageTrackingEnabled: Boolean(classRow && classRow.usage_tracking_enabled),
      entries: rows.map(row => Object.assign(mapDictionary(row), { usedThisWeek: usedIds.has(String(row.id)) }))
    };
  }

  async function saveDictionaryUsage(_anonId, dictionaryId, usageContext) {
    const user = await currentUser();
    const entry = check(await client.from('dictionary').select('id,word_id,approved').eq('id', dictionaryId).maybeSingle());
    if (!entry || !entry.approved) throw new Error('사용 기록을 남길 사전 표현을 찾을 수 없습니다.');
    const word = check(await client.from('words').select('class_id').eq('id', entry.word_id).maybeSingle());
    if (!word) throw new Error('클래스를 찾을 수 없습니다.');
    const classRow = check(await client.from('classes').select('usage_tracking_enabled').eq('id', word.class_id).maybeSingle());
    if (!classRow || !classRow.usage_tracking_enabled) throw new Error('선생님이 실제 사용 기록 기능을 켠 뒤 참여할 수 있습니다.');
    const context = cleanText(usageContext, 400);
    const saved = check(await client.from('dictionary_usage_logs').insert({
      dictionary_id: entry.id,
      owner_id: user.id,
      week_start: currentWeekStart(),
      usage_context: context
    }).select('id').single());
    return { ok: true, id: saved.id };
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
    getStudentUuid,
    verifyAdminCredentials,
    verifyTeacherCode,
    createTeacherClass,
    recoverTeacherClassCode,
    enterTeacherClass,
    joinClass,
    getStudentClassState,
    setClassStage,
    startOpinionDiscussion,
    submitOpinionResponse,
    getOpinionWorkspace,
    getOpinionLesson,
    getClassDashboard,
    getClassWords,
    getAdminDashboard,
    getAdminWords,
    updateWordGroup,
    deleteWordGroup,
    submitWord,
    getApprovedWords,
    saveContextTask,
    deleteContextTask,
    getUsabilityLesson,
    getUsabilityWorkspace,
    saveUsabilityResponse,
    setUsabilityTestActive,
    getDiagnosticLesson,
    getDiagnosticWorkspace,
    setDiagnosticCapacity,
    claimDiagnosticWord,
    saveDiagnosticCard,
    deleteClass,
    resetClassResults,
    getWordmakingWords,
    getWordmakingWorkspace,
    getRedesignLesson,
    getRedesignWorkspace,
    submitDiagnosticRedesign,
    submitWordSuggestion,
    saveSuggestionReview,
    deleteWordSuggestion,
    getAbTestLesson,
    saveAbResponse,
    saveComparisonVote,
    saveAbTest,
    setAbTestActive,
    deleteAbTest,
    getDictionaryWorkspace,
    saveDictionaryEntry,
    setUsageTrackingEnabled,
    getPublishedDictionary,
    saveDictionaryUsage
  };

  global.AppApi = Object.freeze({
    init,
    getAdminToken,
    getTeacherToken,
    subscribeToClassWords(classId, onChange) {
      const id = String(classId || '').trim();
      if (!client || typeof client.channel !== 'function' || typeof onChange !== 'function' || !/^[0-9a-f-]{36}$/i.test(id)) return () => {};
      const channel = client.channel('class-words-' + id + '-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'words', filter: 'class_id=eq.' + id }, onChange)
        .subscribe();
      return () => {
        if (!client || typeof client.removeChannel !== 'function') return;
        const removal = client.removeChannel(channel);
        if (removal && typeof removal.catch === 'function') removal.catch(() => {});
      };
    },
    deactivateClassOnUnload(classId) {
      const id = String(classId || '').trim();
      if (!apiUrl || !apiKey || !accessToken || !/^[0-9a-f-]{36}$/i.test(id)) return false;
      global.fetch(apiUrl + '/rest/v1/classes?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: {
          apikey: apiKey,
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ current_stage: 'waiting', current_task_id: null }),
        keepalive: true
      }).catch(() => {});
      return true;
    },
    async signOut() {
      if (!client) return;
      const result = await client.auth.signOut();
      if (result.error) fail(result.error);
      accessToken = '';
    },
    async call(name, ...args) {
      if (!initialized) throw new Error('Supabase 연결이 초기화되지 않았습니다.');
      if (!Object.prototype.hasOwnProperty.call(methods, name)) throw new Error('지원하지 않는 API 요청입니다: ' + name);
      return methods[name](...args);
    }
  });
})(window);
