(function (global) {
  'use strict';
  let client;
  let signingIn;
  const clean = value => String(value == null ? '' : value).trim();

  function friendly(error) {
    const text = error?.message || String(error || '요청을 처리하지 못했습니다.');
    if (/anonymous sign-ins are disabled/i.test(text)) return '익명 참여 설정이 꺼져 있습니다. 관리자에게 문의해 주세요.';
    if (/failed to fetch|networkerror|timeout|load failed/i.test(text)) return '저장소에 연결하지 못했습니다. 입력 내용은 유지됩니다. 잠시 후 다시 시도해 주세요.';
    if (/rate.limit|too many requests/i.test(text) || error?.status === 429) return '접속 요청이 몰렸어요. 잠시 후 다시 시도해 주세요. 작성 내용은 유지됩니다.';
    if (/schema cache|could not find the function|does not exist/i.test(text)) return '사전 데이터베이스 설정이 아직 완료되지 않았습니다.';
    if (/read.only|disk.full|quota|payment required/i.test(text) || error?.status === 402) return '무료 사용량 제한으로 저장할 수 없습니다. 관리자에게 문의해 주세요.';
    if (/check constraint/i.test(text)) return '필수 내용을 확인해 주세요. 별점은 1~5점, 표현은 80자, 설명은 600자까지 입력할 수 있습니다.';
    if (/foreign key/i.test(text)) return '삭제되었거나 없는 자료입니다. 새로고침해 주세요.';
    if (/permission denied|row.level security/i.test(text)) return '이 작업을 수행할 권한이 없습니다.';
    return text;
  }

  function configured() {
    const config = global.APP_CONFIG || {};
    return /^https:\/\//.test(clean(config.supabaseUrl)) && Boolean(clean(config.supabasePublishableKey));
  }
  function setup() {
    if (client) return client;
    if (!configured()) throw new Error('데이터 저장소 연결을 준비하고 있습니다. 연결이 완료되면 사전을 만들고 저장할 수 있어요.');
    if (!global.supabase?.createClient) throw new Error('연결 기능을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.');
    client = global.supabase.createClient(global.APP_CONFIG.supabaseUrl, global.APP_CONFIG.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: global.localStorage },
      global: { fetch: (url, options = {}) => global.fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(12000) }) }
    });
    return client;
  }
  async function ensureUser() {
    setup();
    if (!signingIn) signingIn = (async () => {
      const session = await client.auth.getSession();
      if (session.error) throw new Error(friendly(session.error));
      if (session.data.session) return;
      const result = await client.auth.signInAnonymously();
      if (result.error) throw new Error(friendly(result.error));
    })().finally(() => { signingIn = null; });
    await signingIn;
  }
  async function rpc(name, args, publicRead = false) {
    setup();
    if (!publicRead) await ensureUser();
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(friendly(result.error));
    return result.data;
  }
  const methods = {
    browseDictionary: (view = 'words', search = '', classId = null, offset = 0) => rpc('dictionary_browse', {
      p_view: view, p_search: clean(search), p_class_id: classId || null, p_offset: offset
    }, true),
    listClasses: (search = '', offset = 0) => rpc('dictionary_list_classes', { p_search: clean(search), p_offset: offset }, true),
    createClass: payload => rpc('dictionary_create', { p_title: clean(payload.title), ...(payload.id ? { p_id: payload.id } : {}) }),
    getClass: (classId, view = 'words', search = '', offset = 0) => rpc('dictionary_get_class', { p_class_id: classId, p_view: view, p_search: clean(search), p_offset: offset }),
    addWord: (classId, payload) => rpc('dictionary_add_word', {
      p_id: payload.id, p_class_id: classId, p_word: clean(payload.word), p_category: payload.category,
      p_meaning: clean(payload.meaning), p_reason: clean(payload.reason)
    }),
    rateWord: (id, score) => rpc('dictionary_rate_word', { p_word_id: id, p_rating: Number(score) }),
    addRevision: (wordId, payload) => rpc('dictionary_propose_revision', {
      p_id: payload.id, p_word_id: wordId, p_word: clean(payload.word), p_meaning: clean(payload.meaning),
      p_reason: clean(payload.reason), p_example: clean(payload.example), p_nickname: clean(payload.nickname)
    }),
    rateRevision: (id, score) => rpc('dictionary_rate_revision', { p_revision_id: id, p_rating: Number(score) }),
    selectRevision: (id, selected) => rpc('dictionary_select_revision', { p_revision_id: id, p_selected: Boolean(selected) }),
    deleteClass: id => rpc('dictionary_delete_class', { p_class_id: id }),
    loginAdmin: async password => {
      const ok = await rpc('dictionary_admin_login', { p_password: password });
      if (!ok) throw new Error('관리자 비밀번호가 다르거나 시도 횟수를 초과했습니다. 5회 실패 시 15분 뒤 다시 시도해 주세요.');
      return true;
    },
    logoutAdmin: () => rpc('dictionary_admin_logout'),
    isAdmin: async () => {
      setup();
      const session = await client.auth.getSession();
      return session.data?.session ? rpc('dictionary_is_admin') : false;
    },
    getUsage: () => rpc('dictionary_usage')
  };
  global.AppApi = Object.freeze({
    configured,
    async init() { setup(); },
    async call(name, ...args) {
      if (!Object.prototype.hasOwnProperty.call(methods, name)) throw new Error('지원하지 않는 요청입니다.');
      return methods[name](...args);
    }
  });
})(window);
