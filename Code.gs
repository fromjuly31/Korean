/**
 * 우리 반 우리말 사전 - Google Apps Script 서버
 * 아래 두 값만 실제 환경에 맞게 바꾼 뒤 웹 앱으로 배포하세요.
 */
const SPREADSHEET_ID = '여기에 구글 스프레드시트 ID 입력';
const TEACHER_PASSWORD = '교사 비밀번호 입력';

const SHEETS = Object.freeze({
  Words: ['id', 'anonId', 'word', 'normalizedWord', 'category', 'createdAt', 'approved'],
  WordRatings: ['id', 'anonId', 'wordId', 'rating', 'createdAt'],
  ContextTasks: ['id', 'wordId', 'word', 'category', 'situation', 'target', 'context', 'active', 'createdAt'],
  ContextExamples: ['id', 'taskId', 'anonId', 'sentence', 'createdAt'],
  ExampleRatings: ['id', 'anonId', 'exampleId', 'rating', 'createdAt'],
  WordSuggestions: ['id', 'wordId', 'originalWord', 'category', 'anonId', 'suggestionType', 'suggestedWord', 'reason', 'exampleSentence', 'createdAt'],
  Dictionary: ['id', 'wordId', 'originalWord', 'category', 'finalWord', 'meaning', 'caution', 'exampleSentence', 'approved', 'updatedAt']
});
const CATEGORIES = Object.freeze(['비속어', '유행어', '외래어']);
const SUGGESTION_TYPES = Object.freeze(['기존 표현으로 바꾸기', '새로운 말 만들기']);
const TEACHER_SESSION_SECONDS = 21600;
let SPREADSHEET_CACHE_ = null;

function doGet(e) {
  ensureSheets_();
  const params = (e && e.parameter) || {};
  const allowedViews = ['teacher', 'submit', 'rate', 'context', 'wordmaking', 'dictionary'];
  const view = allowedViews.indexOf(params.view) > -1 ? params.view : 'teacher';
  const template = HtmlService.createTemplateFromFile('Index');
  const config = {
    view: view,
    taskId: cleanText_(params.taskId || '', 80),
    wordId: cleanText_(params.wordId || '', 80),
    baseUrl: ScriptApp.getService().getUrl() || ''
  };
  template.APP_CONFIG = JSON.stringify(config)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return template.evaluate()
    .setTitle('우리 반 우리말 사전')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 최초 한 번 수동 실행해도 되고, 웹 앱 최초 접속 시에도 자동 실행됩니다. */
function setupApp() {
  ensureSheets_();
  return { ok: true, sheets: Object.keys(SHEETS) };
}

function verifyTeacherPassword(password) {
  if (!TEACHER_PASSWORD || TEACHER_PASSWORD === '교사 비밀번호 입력') {
    throw new Error('Code.gs 상단의 TEACHER_PASSWORD를 먼저 설정해 주세요.');
  }
  if (String(password || '') !== String(TEACHER_PASSWORD)) {
    Utilities.sleep(250);
    throw new Error('비밀번호가 올바르지 않습니다.');
  }
  const token = 'teacher_' + Utilities.getUuid();
  CacheService.getScriptCache().put(token, '1', TEACHER_SESSION_SECONDS);
  return { token: token, expiresIn: TEACHER_SESSION_SECONDS };
}

function getTeacherDashboard(token) {
  assertTeacher_(token);
  const wordGroups = buildWordGroups_();
  const tasks = getTaskSummaries_();
  const dictionary = getDictionaryRows_(false);
  return {
    words: wordGroups.map(publicTeacherWord_),
    stats: buildWordStats_(wordGroups),
    tasks: tasks,
    dictionaryCount: dictionary.filter(function (item) { return item.approved; }).length,
    baseUrl: ScriptApp.getService().getUrl() || ''
  };
}

function getTeacherWords(token) {
  assertTeacher_(token);
  const wordGroups = buildWordGroups_();
  return { words: wordGroups.map(publicTeacherWord_), stats: buildWordStats_(wordGroups) };
}

function updateWordGroup(token, wordId, changes) {
  assertTeacher_(token);
  changes = changes || {};
  if (changes.category !== undefined) assertCategory_(changes.category);
  return withWriteLock_(function () {
    const rows = getRows_('Words');
    const target = rows.find(function (row) { return String(row.id) === String(wordId); });
    if (!target) throw new Error('해당 표현을 찾을 수 없습니다.');
    const key = String(target.normalizedWord);
    const sheet = getSheet_('Words');
    let changed = 0;
    rows.forEach(function (row) {
      if (String(row.normalizedWord) !== key) return;
      if (changes.category !== undefined) sheet.getRange(row.__row, 5).setValue(changes.category);
      if (changes.approved !== undefined) sheet.getRange(row.__row, 7).setValue(Boolean(changes.approved));
      changed += 1;
    });
    SpreadsheetApp.flush();
    return { ok: true, changed: changed };
  });
}

function deleteWordGroup(token, wordId) {
  assertTeacher_(token);
  return withWriteLock_(function () {
    const words = getRows_('Words');
    const target = words.find(function (row) { return String(row.id) === String(wordId); });
    if (!target) throw new Error('해당 표현을 찾을 수 없습니다.');
    const ids = words.filter(function (row) {
      return String(row.normalizedWord) === String(target.normalizedWord);
    }).map(function (row) { return String(row.id); });
    const idSet = Object.create(null);
    ids.forEach(function (id) { idSet[id] = true; });

    const taskIds = getRows_('ContextTasks').filter(function (row) {
      return idSet[String(row.wordId)];
    }).map(function (row) { return String(row.id); });
    const taskSet = Object.create(null);
    taskIds.forEach(function (id) { taskSet[id] = true; });
    const exampleIds = getRows_('ContextExamples').filter(function (row) {
      return taskSet[String(row.taskId)];
    }).map(function (row) { return String(row.id); });
    const exampleSet = Object.create(null);
    exampleIds.forEach(function (id) { exampleSet[id] = true; });

    rewriteRows_('Words', words.filter(function (row) { return !idSet[String(row.id)]; }));
    rewriteRows_('WordRatings', getRows_('WordRatings').filter(function (row) { return !idSet[String(row.wordId)]; }));
    rewriteRows_('ContextTasks', getRows_('ContextTasks').filter(function (row) { return !taskSet[String(row.id)]; }));
    rewriteRows_('ContextExamples', getRows_('ContextExamples').filter(function (row) { return !exampleSet[String(row.id)]; }));
    rewriteRows_('ExampleRatings', getRows_('ExampleRatings').filter(function (row) { return !exampleSet[String(row.exampleId)]; }));
    rewriteRows_('WordSuggestions', getRows_('WordSuggestions').filter(function (row) { return !idSet[String(row.wordId)]; }));
    rewriteRows_('Dictionary', getRows_('Dictionary').filter(function (row) { return !idSet[String(row.wordId)]; }));
    return { ok: true };
  });
}

function submitWord(anonId, word, category) {
  assertAnonId_(anonId);
  assertCategory_(category);
  const original = cleanText_(word, 80);
  if (!original) throw new Error('단어 또는 표현을 입력해 주세요.');
  const normalized = normalizeWord_(original);
  if (!normalized) throw new Error('문자나 숫자가 포함된 표현을 입력해 주세요.');
  return withWriteLock_(function () {
    const rows = getRows_('Words');
    const nowMs = Date.now();
    const recent = rows.find(function (row) {
      const time = Date.parse(row.createdAt) || 0;
      return row.anonId === anonId && row.normalizedWord === normalized && row.category === category && nowMs - time < 15000;
    });
    if (recent) return { ok: true, duplicatePrevented: true, id: recent.id };
    const id = newId_('word');
    appendObject_('Words', {
      id: id,
      anonId: anonId,
      word: original,
      normalizedWord: normalized,
      category: category,
      createdAt: nowIso_(),
      approved: false
    });
    return { ok: true, id: id };
  });
}

function getApprovedWords(anonId) {
  assertAnonId_(anonId);
  const groups = buildWordGroups_().filter(function (word) { return word.approved; });
  return groups.map(function (word) {
    return {
      id: word.id,
      word: word.word,
      category: word.category,
      submissionCount: word.submissionCount,
      averageRating: word.averageRating,
      ratingCount: word.ratingCount,
      mine: word.submitterAnonIds.indexOf(anonId) > -1,
      myRating: word.ratingsByAnon[anonId] || 0
    };
  });
}

function saveWordRating(anonId, wordId, rating) {
  assertAnonId_(anonId);
  const score = assertRating_(rating);
  return withWriteLock_(function () {
    const groups = buildWordGroups_();
    const word = groups.find(function (item) { return String(item.id) === String(wordId); });
    if (!word || !word.approved) throw new Error('평가할 수 없는 표현입니다.');
    return upsertRating_('WordRatings', anonId, 'wordId', String(word.id), score);
  });
}

function saveContextTask(token, task) {
  assertTeacher_(token);
  task = task || {};
  const situation = requiredText_(task.situation, '상황', 500);
  const target = requiredText_(task.target, '상대', 200);
  const context = requiredText_(task.context, '맥락', 500);
  return withWriteLock_(function () {
    const words = buildWordGroups_();
    const word = words.find(function (item) { return String(item.id) === String(task.wordId); });
    if (!word || !word.approved) throw new Error('승인된 표현을 선택해 주세요.');
    const rows = getRows_('ContextTasks');
    if (task.id) {
      const existing = rows.find(function (row) { return String(row.id) === String(task.id); });
      if (!existing) throw new Error('수정할 활동을 찾을 수 없습니다.');
      const sheet = getSheet_('ContextTasks');
      const values = [existing.id, word.id, word.word, word.category, situation, target, context,
        task.active === undefined ? asBool_(existing.active) : Boolean(task.active), existing.createdAt || nowIso_()];
      sheet.getRange(existing.__row, 1, 1, SHEETS.ContextTasks.length).setValues([safeRow_(values)]);
      return { ok: true, id: existing.id };
    }
    const id = newId_('task');
    appendObject_('ContextTasks', {
      id: id, wordId: word.id, word: word.word, category: word.category,
      situation: situation, target: target, context: context,
      active: task.active === undefined ? true : Boolean(task.active), createdAt: nowIso_()
    });
    return { ok: true, id: id };
  });
}

function deleteContextTask(token, taskId) {
  assertTeacher_(token);
  return withWriteLock_(function () {
    const tasks = getRows_('ContextTasks');
    if (!tasks.some(function (row) { return String(row.id) === String(taskId); })) {
      throw new Error('삭제할 활동을 찾을 수 없습니다.');
    }
    const examples = getRows_('ContextExamples');
    const exampleIds = examples.filter(function (row) { return String(row.taskId) === String(taskId); })
      .map(function (row) { return String(row.id); });
    const exampleSet = Object.create(null);
    exampleIds.forEach(function (id) { exampleSet[id] = true; });
    rewriteRows_('ContextTasks', tasks.filter(function (row) { return String(row.id) !== String(taskId); }));
    rewriteRows_('ContextExamples', examples.filter(function (row) { return String(row.taskId) !== String(taskId); }));
    rewriteRows_('ExampleRatings', getRows_('ExampleRatings').filter(function (row) { return !exampleSet[String(row.exampleId)]; }));
    return { ok: true };
  });
}

function getContextActivity(taskId, anonId) {
  assertAnonId_(anonId);
  const task = getRows_('ContextTasks').find(function (row) {
    return String(row.id) === String(taskId) && asBool_(row.active);
  });
  if (!task) throw new Error('활동을 찾을 수 없거나 종료된 활동입니다.');
  const ratings = getRows_('ExampleRatings');
  const byExample = groupBy_(ratings, 'exampleId');
  const examples = getRows_('ContextExamples').filter(function (row) {
    return String(row.taskId) === String(taskId);
  }).map(function (row) {
    const list = byExample[String(row.id)] || [];
    const ownRating = list.find(function (rating) { return rating.anonId === anonId; });
    return {
      id: row.id,
      sentence: row.sentence,
      createdAt: row.createdAt,
      mine: row.anonId === anonId,
      myRating: ownRating ? Number(ownRating.rating) : 0,
      averageRating: average_(list.map(function (rating) { return Number(rating.rating); })),
      ratingCount: list.length
    };
  });
  return { task: publicTask_(task), examples: examples };
}

function submitContextExample(anonId, taskId, sentence) {
  assertAnonId_(anonId);
  const text = requiredText_(sentence, '예문', 800);
  return withWriteLock_(function () {
    const task = getRows_('ContextTasks').find(function (row) {
      return String(row.id) === String(taskId) && asBool_(row.active);
    });
    if (!task) throw new Error('활동을 찾을 수 없거나 종료된 활동입니다.');
    const rows = getRows_('ContextExamples');
    const existing = rows.find(function (row) { return row.anonId === anonId && String(row.taskId) === String(taskId); });
    if (existing) {
      getSheet_('ContextExamples').getRange(existing.__row, 4).setValue(safeCell_(text));
      return { ok: true, id: existing.id, updated: true };
    }
    const id = newId_('example');
    appendObject_('ContextExamples', { id: id, taskId: taskId, anonId: anonId, sentence: text, createdAt: nowIso_() });
    return { ok: true, id: id, updated: false };
  });
}

function saveExampleRating(anonId, exampleId, rating) {
  assertAnonId_(anonId);
  const score = assertRating_(rating);
  return withWriteLock_(function () {
    const example = getRows_('ContextExamples').find(function (row) { return String(row.id) === String(exampleId); });
    if (!example) throw new Error('평가할 예문을 찾을 수 없습니다.');
    if (example.anonId === anonId) throw new Error('내 예문은 평가할 수 없습니다.');
    return upsertRating_('ExampleRatings', anonId, 'exampleId', String(exampleId), score);
  });
}

function getContextResults(token, taskId) {
  assertTeacher_(token);
  const task = getRows_('ContextTasks').find(function (row) { return String(row.id) === String(taskId); });
  if (!task) throw new Error('활동을 찾을 수 없습니다.');
  const ratings = getRows_('ExampleRatings');
  const byExample = groupBy_(ratings, 'exampleId');
  const examples = getRows_('ContextExamples').filter(function (row) {
    return String(row.taskId) === String(taskId);
  }).map(function (row) {
    const list = byExample[String(row.id)] || [];
    return {
      id: row.id, sentence: row.sentence, createdAt: row.createdAt,
      averageRating: average_(list.map(function (rating) { return Number(rating.rating); })),
      ratingCount: list.length
    };
  });
  return { task: publicTask_(task), examples: examples };
}

function getWordmakingWords(anonId) {
  assertAnonId_(anonId);
  const suggestions = getRows_('WordSuggestions');
  const mine = Object.create(null);
  suggestions.forEach(function (row) {
    if (row.anonId === anonId) {
      mine[String(row.wordId)] = {
        suggestionType: row.suggestionType,
        suggestedWord: row.suggestedWord,
        reason: row.reason,
        exampleSentence: row.exampleSentence
      };
    }
  });
  return buildWordGroups_().filter(function (word) { return word.approved; }).map(function (word) {
    return {
      id: word.id,
      word: word.word,
      category: word.category,
      submitted: Boolean(mine[String(word.id)]),
      ownSuggestion: mine[String(word.id)] || null
    };
  });
}

function submitWordSuggestion(anonId, payload) {
  assertAnonId_(anonId);
  payload = payload || {};
  if (SUGGESTION_TYPES.indexOf(payload.suggestionType) < 0) throw new Error('제안 유형을 선택해 주세요.');
  const suggestedWord = requiredText_(payload.suggestedWord, '바꾼 표현', 120);
  const reason = requiredText_(payload.reason, '바꾼 이유', 600);
  const exampleSentence = requiredText_(payload.exampleSentence, '예문', 800);
  return withWriteLock_(function () {
    const word = buildWordGroups_().find(function (item) {
      return String(item.id) === String(payload.wordId) && item.approved;
    });
    if (!word) throw new Error('제안할 표현을 찾을 수 없습니다.');
    const rows = getRows_('WordSuggestions');
    const existing = rows.find(function (row) {
      return row.anonId === anonId && String(row.wordId) === String(word.id);
    });
    const values = {
      id: existing ? existing.id : newId_('suggestion'),
      wordId: word.id,
      originalWord: word.word,
      category: word.category,
      anonId: anonId,
      suggestionType: payload.suggestionType,
      suggestedWord: suggestedWord,
      reason: reason,
      exampleSentence: exampleSentence,
      createdAt: existing ? existing.createdAt : nowIso_()
    };
    if (existing) {
      const ordered = SHEETS.WordSuggestions.map(function (header) { return values[header]; });
      getSheet_('WordSuggestions').getRange(existing.__row, 1, 1, ordered.length).setValues([safeRow_(ordered)]);
      return { ok: true, id: existing.id, updated: true };
    }
    appendObject_('WordSuggestions', values);
    return { ok: true, id: values.id, updated: false };
  });
}

function getDictionaryWorkspace(token) {
  assertTeacher_(token);
  const words = buildWordGroups_().filter(function (word) { return word.approved; });
  const suggestions = groupBy_(getRows_('WordSuggestions'), 'wordId');
  const entries = getDictionaryRows_(false);
  const entryByWord = Object.create(null);
  entries.forEach(function (entry) { entryByWord[String(entry.wordId)] = entry; });
  return words.map(function (word) {
    return {
      id: word.id,
      word: word.word,
      category: word.category,
      suggestions: (suggestions[String(word.id)] || []).map(function (row) {
        return {
          id: row.id, suggestionType: row.suggestionType, suggestedWord: row.suggestedWord,
          reason: row.reason, exampleSentence: row.exampleSentence, createdAt: row.createdAt
        };
      }),
      entry: entryByWord[String(word.id)] || null
    };
  });
}

function saveDictionaryEntry(token, payload) {
  assertTeacher_(token);
  payload = payload || {};
  const originalWord = requiredText_(payload.originalWord, '원래 표현', 120);
  assertCategory_(payload.category);
  const finalWord = cleanText_(payload.finalWord, 160);
  const meaning = cleanText_(payload.meaning, 1200);
  const caution = cleanText_(payload.caution, 1200);
  const exampleSentence = cleanText_(payload.exampleSentence, 1200);
  const approved = Boolean(payload.approved);
  if (approved && (!finalWord || !meaning)) throw new Error('사전에 등록하려면 최종 추천 표현과 뜻을 입력해 주세요.');
  return withWriteLock_(function () {
    const word = buildWordGroups_().find(function (item) { return String(item.id) === String(payload.wordId); });
    if (!word || !word.approved) throw new Error('승인된 원래 표현을 찾을 수 없습니다.');
    const rows = getRows_('Dictionary');
    const existing = rows.find(function (row) { return String(row.wordId) === String(word.id); });
    const record = {
      id: existing ? existing.id : newId_('dict'),
      wordId: word.id,
      originalWord: originalWord,
      category: payload.category,
      finalWord: finalWord,
      meaning: meaning,
      caution: caution,
      exampleSentence: exampleSentence,
      approved: approved,
      updatedAt: nowIso_()
    };
    if (existing) {
      const ordered = SHEETS.Dictionary.map(function (header) { return record[header]; });
      getSheet_('Dictionary').getRange(existing.__row, 1, 1, ordered.length).setValues([safeRow_(ordered)]);
    } else {
      appendObject_('Dictionary', record);
    }
    return { ok: true, id: record.id };
  });
}

function getPublishedDictionary() {
  return getDictionaryRows_(true).map(function (entry) {
    return {
      id: entry.id,
      originalWord: entry.originalWord,
      category: entry.category,
      finalWord: entry.finalWord,
      meaning: entry.meaning,
      caution: entry.caution,
      exampleSentence: entry.exampleSentence,
      updatedAt: entry.updatedAt
    };
  });
}

/* ---------------------------- 내부 도우미 ---------------------------- */

function getSpreadsheet_() {
  if (SPREADSHEET_CACHE_) return SPREADSHEET_CACHE_;
  if (!SPREADSHEET_ID || SPREADSHEET_ID === '여기에 구글 스프레드시트 ID 입력') {
    throw new Error('Code.gs 상단의 SPREADSHEET_ID를 먼저 설정해 주세요.');
  }
  try {
    SPREADSHEET_CACHE_ = SpreadsheetApp.openById(String(SPREADSHEET_ID).trim());
    return SPREADSHEET_CACHE_;
  } catch (error) {
    throw new Error('스프레드시트에 연결할 수 없습니다. ID와 실행 계정의 권한을 확인해 주세요.');
  }
}

function ensureSheets_() {
  const spreadsheet = getSpreadsheet_();
  Object.keys(SHEETS).forEach(function (name) {
    let sheet = spreadsheet.getSheetByName(name);
    let initialized = false;
    if (!sheet) {
      sheet = spreadsheet.insertSheet(name);
      initialized = true;
    }
    const headers = SHEETS[name];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      initialized = true;
    } else {
      const current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
      headers.forEach(function (header, index) {
        if (current[index] !== header) {
          throw new Error(name + ' 시트의 ' + (index + 1) + '번째 열 제목은 "' + header + '"이어야 합니다.');
        }
      });
    }
    if (initialized) {
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#E9F1FF');
    }
  });
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    ensureSheets_();
    return getSpreadsheet_().getSheetByName(name);
  }
  return sheet;
}

function getRows_(name) {
  const sheet = getSheet_(name);
  const lastRow = sheet.getLastRow();
  const headers = SHEETS[name];
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (valuesRow, index) {
    const object = { __row: index + 2 };
    headers.forEach(function (header, column) {
      const value = valuesRow[column];
      object[header] = value instanceof Date ? value.toISOString() : value;
    });
    return object;
  });
}

function appendObject_(name, object) {
  const headers = SHEETS[name];
  const row = headers.map(function (header) { return object[header] === undefined ? '' : object[header]; });
  getSheet_(name).appendRow(safeRow_(row));
}

function rewriteRows_(name, rows) {
  const sheet = getSheet_(name);
  const headers = SHEETS[name];
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (!rows.length) return;
  const values = rows.map(function (row) {
    return safeRow_(headers.map(function (header) { return row[header] === undefined ? '' : row[header]; }));
  });
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function safeRow_(row) {
  return row.map(safeCell_);
}

function safeCell_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

function withWriteLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureSheets_();
    const result = callback();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function assertTeacher_(token) {
  const key = String(token || '');
  if (!key || CacheService.getScriptCache().get(key) !== '1') {
    throw new Error('교사 인증이 만료되었습니다. 다시 로그인해 주세요.');
  }
  CacheService.getScriptCache().put(key, '1', TEACHER_SESSION_SECONDS);
}

function assertAnonId_(anonId) {
  if (!/^anon_[a-z0-9-]{12,80}$/i.test(String(anonId || ''))) {
    throw new Error('익명 식별 정보를 확인할 수 없습니다. 페이지를 새로고침해 주세요.');
  }
}

function assertCategory_(category) {
  if (CATEGORIES.indexOf(String(category || '')) < 0) throw new Error('유형을 올바르게 선택해 주세요.');
}

function assertRating_(rating) {
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('별점은 1~5점으로 입력해 주세요.');
  return value;
}

function requiredText_(value, label, maxLength) {
  const text = cleanText_(value, maxLength);
  if (!text) throw new Error(label + '을(를) 입력해 주세요.');
  return text;
}

function cleanText_(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).replace(/\u0000/g, '').trim().slice(0, maxLength || 2000);
}

function normalizeWord_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.!！?？,，。·~～…]+/g, '')
    .replace(/[ㅋㅎㅠㅜ]{2,}$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '');
}

function nowIso_() {
  return new Date().toISOString();
}

function asBool_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function average_(numbers) {
  const valid = numbers.filter(function (number) { return Number.isFinite(number); });
  if (!valid.length) return 0;
  return Math.round((valid.reduce(function (sum, number) { return sum + number; }, 0) / valid.length) * 10) / 10;
}

function groupBy_(rows, key) {
  return rows.reduce(function (result, row) {
    const value = String(row[key]);
    if (!result[value]) result[value] = [];
    result[value].push(row);
    return result;
  }, Object.create(null));
}

function buildWordGroups_() {
  const rows = getRows_('Words');
  const ratings = getRows_('WordRatings');
  const grouped = groupBy_(rows, 'normalizedWord');
  const ratingsByWord = groupBy_(ratings, 'wordId');
  return Object.keys(grouped).map(function (key) {
    const submissions = grouped[key];
    const representative = submissions[0];
    const ids = submissions.map(function (row) { return String(row.id); });
    let allRatings = [];
    ids.forEach(function (id) { allRatings = allRatings.concat(ratingsByWord[id] || []); });
    const latestByAnon = Object.create(null);
    allRatings.forEach(function (rating) { latestByAnon[rating.anonId] = Number(rating.rating); });
    const scores = Object.keys(latestByAnon).map(function (anonId) { return latestByAnon[anonId]; });
    const categoryCounts = Object.create(null);
    submissions.forEach(function (row) {
      const category = CATEGORIES.indexOf(row.category) > -1 ? row.category : '유행어';
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });
    const category = CATEGORIES.slice().sort(function (a, b) { return (categoryCounts[b] || 0) - (categoryCounts[a] || 0); })[0];
    const mean = scores.length ? scores.reduce(function (a, b) { return a + b; }, 0) / scores.length : 0;
    const variance = scores.length ? scores.reduce(function (sum, score) { return sum + Math.pow(score - mean, 2); }, 0) / scores.length : 0;
    return {
      id: representative.id,
      word: representative.word,
      normalizedWord: key,
      category: category,
      submissionCount: submissions.length,
      averageRating: Math.round(mean * 10) / 10,
      ratingCount: scores.length,
      ratingSpread: Math.round(Math.sqrt(variance) * 10) / 10,
      approved: submissions.some(function (row) { return asBool_(row.approved); }),
      createdAt: representative.createdAt,
      submitterAnonIds: submissions.map(function (row) { return row.anonId; }),
      ratingsByAnon: latestByAnon
    };
  }).sort(function (a, b) {
    return b.submissionCount - a.submissionCount || String(a.word).localeCompare(String(b.word), 'ko');
  });
}

function buildWordStats_(words) {
  const stats = { total: words.length, '비속어': 0, '유행어': 0, '외래어': 0, ratingCount: 0 };
  words.forEach(function (word) {
    stats[word.category] = (stats[word.category] || 0) + 1;
    stats.ratingCount += word.ratingCount;
  });
  const rated = words.filter(function (word) { return word.ratingCount > 0; });
  const take = function (list) {
    return list.slice(0, 5).map(function (word) {
      return { word: word.word, value: word.averageRating, count: word.ratingCount };
    });
  };
  stats.highest = take(rated.slice().sort(function (a, b) { return b.averageRating - a.averageRating; }));
  stats.lowest = take(rated.slice().sort(function (a, b) { return a.averageRating - b.averageRating; }));
  stats.divisive = rated.slice().sort(function (a, b) { return b.ratingSpread - a.ratingSpread; }).slice(0, 5).map(function (word) {
    return { word: word.word, value: word.ratingSpread, count: word.ratingCount };
  });
  stats.frequent = words.slice().sort(function (a, b) { return b.submissionCount - a.submissionCount; }).slice(0, 5).map(function (word) {
    return { word: word.word, value: word.submissionCount, count: word.submissionCount };
  });
  return stats;
}

function publicTeacherWord_(word) {
  return {
    id: word.id,
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

function getTaskSummaries_() {
  const tasks = getRows_('ContextTasks');
  const examples = getRows_('ContextExamples');
  const ratings = getRows_('ExampleRatings');
  const examplesByTask = groupBy_(examples, 'taskId');
  const ratingsByExample = groupBy_(ratings, 'exampleId');
  return tasks.map(function (task) {
    const taskExamples = examplesByTask[String(task.id)] || [];
    let scores = [];
    taskExamples.forEach(function (example) {
      scores = scores.concat((ratingsByExample[String(example.id)] || []).map(function (row) { return Number(row.rating); }));
    });
    const result = publicTask_(task);
    result.exampleCount = taskExamples.length;
    result.averageRating = average_(scores);
    result.ratingCount = scores.length;
    return result;
  }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}

function publicTask_(task) {
  return {
    id: task.id, wordId: task.wordId, word: task.word, category: task.category,
    situation: task.situation, target: task.target, context: task.context,
    active: asBool_(task.active), createdAt: task.createdAt
  };
}

function upsertRating_(sheetName, anonId, foreignKeyName, foreignId, score) {
  const rows = getRows_(sheetName);
  const existing = rows.find(function (row) {
    return row.anonId === anonId && String(row[foreignKeyName]) === String(foreignId);
  });
  if (existing) {
    const sheet = getSheet_(sheetName);
    const ratingColumn = SHEETS[sheetName].indexOf('rating') + 1;
    const createdColumn = SHEETS[sheetName].indexOf('createdAt') + 1;
    sheet.getRange(existing.__row, ratingColumn).setValue(score);
    sheet.getRange(existing.__row, createdColumn).setValue(nowIso_());
    return { ok: true, id: existing.id, updated: true };
  }
  const object = { id: newId_('rating'), anonId: anonId, rating: score, createdAt: nowIso_() };
  object[foreignKeyName] = foreignId;
  appendObject_(sheetName, object);
  return { ok: true, id: object.id, updated: false };
}

function getDictionaryRows_(onlyApproved) {
  return getRows_('Dictionary').filter(function (row) {
    return !onlyApproved || asBool_(row.approved);
  }).map(function (row) {
    return {
      id: row.id, wordId: row.wordId, originalWord: row.originalWord, category: row.category,
      finalWord: row.finalWord, meaning: row.meaning, caution: row.caution,
      exampleSentence: row.exampleSentence, approved: asBool_(row.approved), updatedAt: row.updatedAt
    };
  }).sort(function (a, b) { return String(a.originalWord).localeCompare(String(b.originalWord), 'ko'); });
}
