/**
 * 챗로그 클라이언트 확장
 * 배치: SillyTavern/data/<사용자 폴더>/extensions/chatlog/
 */

const API = '/api/plugins/chatlog';
const CHATLOG_VERSION = '0.9.10';
const MAX_MANUAL_IMAGE_BYTES = 20 * 1024 * 1024;
const CARD_SYNC_TEXT_BUDGET_BYTES = 240 * 1024;
const ROOM_SYNC_TEXT_BUDGET_BYTES = 7 * 1024 * 1024;
const PERSONA_SYNC_TEXT_BUDGET_BYTES = 240 * 1024;
const UTF8_ENCODER = new TextEncoder();
const cardSyncWarnings = new Set();

// ── 유틸 ──────────────────────────────────────────────────
const ctx = () => window.SillyTavern?.getContext?.() || {};
const headers = () => { try { return ctx().getRequestHeaders?.() || {}; } catch { return {}; } };

async function api(pathname, body) {
    const opts = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(body) }
        : { headers: headers() };
    const res = await fetch(API + pathname, opts);
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error || `${pathname} ${res.status}`);
    }
    return res.json();
}

const esc = (s) => $('<div>').text(s ?? '').html();
const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}[character]));
const notify = (type, message) => {
    const method = window.toastr?.[type];
    if (typeof method === 'function') {
        method.call(window.toastr, String(message ?? ''), undefined, { escapeHtml: true });
        return;
    }
    if (type === 'error') window.alert(String(message ?? ''));
};
const showError = (message) => {
    notify('error', message);
};

function utf8Length(value) {
    return UTF8_ENCODER.encode(String(value ?? '')).byteLength;
}

function truncateUtf8(value, maxBytes) {
    const input = String(value ?? '');
    if (maxBytes <= 0) return '';
    if (utf8Length(input) <= maxBytes) return input;
    let low = 0;
    let high = input.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (utf8Length(input.slice(0, middle)) <= maxBytes) low = middle;
        else high = middle - 1;
    }
    let output = input.slice(0, low);
    const last = output.charCodeAt(output.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) output = output.slice(0, -1);
    return output;
}

function fitTextFields(source, fields, budgetBytes) {
    const fitted = {};
    let remaining = budgetBytes;
    let truncated = false;
    for (const field of fields) {
        const original = String(source?.[field] ?? '');
        const value = truncateUtf8(original, remaining);
        fitted[field] = value;
        remaining = Math.max(0, remaining - utf8Length(value));
        if (value !== original) truncated = true;
    }
    return { fitted, truncated };
}

function attachSyncMeta(value, truncated) {
    Object.defineProperty(value, '__chatlogTruncated', {
        value: !!truncated,
        enumerable: false,
        configurable: false,
    });
    return value;
}

function personaSnapshotForSync(persona) {
    const description = truncateUtf8(
        persona?.description || '',
        PERSONA_SYNC_TEXT_BUDGET_BYTES,
    );
    return attachSyncMeta({
        name: persona?.name || '나',
        description,
        avatar: persona?.file || persona?.avatar || null,
    }, description !== String(persona?.description || ''));
}

function warnCardSyncOnce(key, message) {
    if (cardSyncWarnings.has(key)) return;
    cardSyncWarnings.add(key);
    notify('warning', message);
}

function fitRoomMemberSnapshots(members) {
    let remaining = ROOM_SYNC_TEXT_BUDGET_BYTES;
    return (members || []).map(member => {
        const perMemberBudget = Math.min(CARD_SYNC_TEXT_BUDGET_BYTES, remaining);
        const { fitted, truncated } = fitTextFields(
            member,
            ['description', 'personality', 'scenario', 'mesExample'],
            perMemberBudget,
        );
        const used = Object.values(fitted)
            .reduce((total, value) => total + utf8Length(value), 0);
        remaining = Math.max(0, remaining - used);
        return attachSyncMeta(
            { ...member, ...fitted },
            member.__chatlogTruncated || truncated,
        );
    });
}

function cleanDisplayName(value) {
    let name = String(value || '').trim();
    try { name = decodeURIComponent(name); } catch { /* 이미 일반 문자열 */ }
    name = name.split(/[\\/]/).pop().replace(/\.(png|jpe?g|webp|gif|avif)$/i, '').trim();
    return name || '캐릭터';
}

function characterName(room, avatar, storedName) {
    if (avatar === 'user') return personaForRoom(room).name;
    const member = room?.members?.find(m => m.avatar === avatar);
    return cleanDisplayName(member?.name || storedName || avatar);
}

function timeLabel(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ── 표시 페르소나 / 캐릭터별 연결 페르소나 ───────────────
function personaStore() {
    const c = ctx();
    const pu = c.powerUserSettings || window.power_user || {};
    return {
        c,
        pu,
        descs: pu.persona_descriptions || {},
        names: pu.personas || {},
    };
}

function normalizePersona(persona) {
    if (!persona) return null;
    return {
        file: persona.file || persona.avatar || null,
        name: persona.name || ctx().name1 || '나',
        description: persona.description || '',
    };
}

function personaFromFile(file) {
    if (!file) return null;
    const { c, descs, names } = personaStore();
    const meta = descs[file];
    return {
        file,
        name: names[file] || c.name1 || '나',
        description: typeof meta === 'string'
            ? meta
            : (meta?.description || meta?.prompt || ''),
    };
}

function activePersona() {
    const { c, pu } = personaStore();
    const file = c.userAvatar || window.user_avatar || pu.default_persona;
    return personaFromFile(file) || { file: null, name: c.name1 || '나', description: '' };
}

function connectionTarget(conn) {
    if (!conn) return '';
    return String(typeof conn === 'string'
        ? conn
        : (conn.id ?? conn.characterKey ?? conn.avatar ?? ''));
}

function linkedPersonaForMember(member) {
    if (!member?.avatar) return null;
    const { descs } = personaStore();
    const target = String(member.avatar);

    for (const [file, meta] of Object.entries(descs)) {
        if ((meta?.connections || []).some(conn => connectionTarget(conn) === target)) {
            return personaFromFile(file);
        }
    }
    return null;
}

function connectedPersonasForMembers(members) {
    const unique = new Map();
    for (const member of members || []) {
        const persona = linkedPersonaForMember(member);
        if (!persona) continue;
        unique.set(persona.file || persona.name, persona);
    }
    return [...unique.values()];
}

function memberPersonasForMembers(members) {
    return Object.fromEntries((members || [])
        .map(member => [member.avatar, linkedPersonaForMember(member)])
        .filter(([, persona]) => !!persona)
        .map(([avatar, persona]) => [avatar, personaSnapshotForSync(persona)]));
}

/**
 * 방 화면에 표시할 페르소나. 새 단톡 생성 때 고른 room.persona를 우선하고,
 * 예전 방처럼 저장값이 없을 때만 현재 활성 페르소나로 폴백한다.
 */
function personaForRoom(room) {
    const stored = normalizePersona(room?.persona);
    if (stored) return stored;
    return activePersona();
}

/**
 * AI 관계 판단용 페르소나. 캐릭터 연결값을 우선하고 없으면 표시 페르소나를 쓴다.
 */
function personaForMember(room, member) {
    const stored = normalizePersona(room?.memberPersonas?.[member?.avatar]);
    return stored || linkedPersonaForMember(member) || personaForRoom(room);
}

function relationshipContextForRoom(room) {
    const actor = personaForRoom(room);
    const graph = room?.relationshipGraph;
    const lines = [
        '[단톡 공통 관계도]',
        `현재 user로 글과 댓글을 쓰는 실제 인물: ${actor.name}`,
        '- 이 인물을 캐릭터별 개인 연결 페르소나로 바꾸지 않는다.',
    ];
    if (graph?.status !== 'ready') {
        lines.push('- 저장된 관계 분석이 없으므로 명시되지 않은 관계를 만들지 않는다.');
        return lines.join('\n');
    }
    for (const relation of graph.memberRelations || []) {
        if (!['explicit', 'manual'].includes(relation.confidence) || relation.type === 'unknown') continue;
        lines.push(`- ${actor.name} ↔ ${relation.memberName}: ${relation.label}`);
        if (relation.memberCallsPersona) lines.push(`  · ${relation.memberName}의 호칭: ${relation.memberCallsPersona}`);
        if (relation.forbiddenTerms) lines.push(`  · 금지 호칭: ${relation.forbiddenTerms}`);
    }
    for (const relation of graph.characterRelations || []) {
        if (!['explicit', 'manual'].includes(relation.confidence) || relation.type === 'unknown') continue;
        lines.push(`- ${relation.aName} ↔ ${relation.bName}: ${relation.label}`);
    }
    if (graph.summary) lines.push(`- 공통 요약: ${graph.summary}`);
    return lines.join('\n');
}

function userAvatarUrl(room) {
    const p = personaForRoom(room);
    if (p.file) return `/User Avatars/${encodeURIComponent(p.file)}`;
    const domSrc = $('.mes[is_user="true"]').last().find('.avatar img').attr('src');
    return domSrc || '/img/user-default.png';
}

function avatarUrl(avatar, room) {
    return avatar === 'user'
        ? userAvatarUrl(room)
        : `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
}

function characterSnapshot(ch, avatar = ch?.avatar) {
    const data = ch?.data || {};
    const source = {
        avatar,
        name: ch?.name ?? data.name ?? cleanDisplayName(avatar),
        description: ch?.description ?? data.description ?? '',
        personality: ch?.personality ?? data.personality ?? '',
        scenario: ch?.scenario ?? data.scenario ?? '',
        mesExample: ch?.mes_example ?? ch?.mesExample ?? data.mes_example ?? '',
    };
    const { fitted, truncated } = fitTextFields(
        source,
        ['description', 'personality', 'scenario', 'mesExample'],
        CARD_SYNC_TEXT_BUDGET_BYTES,
    );
    return attachSyncMeta({ ...source, ...fitted }, truncated);
}

async function syncRoomCharacterCards() {
    const chars = ctx().characters || [];
    if (!chars.length) return;

    for (const room of Object.values(state.rooms || {})) {
        const truncatedNames = [];
        const members = fitRoomMemberSnapshots((room.members || []).map(old => {
            const ch = chars.find(item => item.avatar === old.avatar);
            const snapshot = characterSnapshot(ch || old, old.avatar);
            if (snapshot.__chatlogTruncated) {
                truncatedNames.push(snapshot.name || cleanDisplayName(old.avatar));
            }
            return { ...old, ...snapshot };
        }));
        for (const member of members) {
            if (member.__chatlogTruncated
                && !truncatedNames.includes(member.name || cleanDisplayName(member.avatar))) {
                truncatedNames.push(member.name || cleanDisplayName(member.avatar));
            }
        }
        const persona = personaForRoom({ ...room, members });
        const personaSnapshot = personaSnapshotForSync(persona);
        if (personaSnapshot.__chatlogTruncated) {
            warnCardSyncOnce(
                `persona:${room.id}:${personaSnapshot.avatar || personaSnapshot.name}`,
                `${personaSnapshot.name} 페르소나 설명이 매우 길어 챗로그용 사본은 앞부분 240KB까지만 사용합니다.`,
            );
        }
        const personaRecordsReady = Object.keys(personaStore().descs).length > 0;
        const memberPersonas = personaRecordsReady
            ? memberPersonasForMembers(members)
            : (room.memberPersonas || {});
        for (const [memberAvatar, linkedPersona] of Object.entries(memberPersonas)) {
            if (!linkedPersona?.__chatlogTruncated) continue;
            const memberName = members.find(member => member.avatar === memberAvatar)?.name
                || cleanDisplayName(memberAvatar);
            warnCardSyncOnce(
                `linked-persona:${room.id}:${memberAvatar}:${linkedPersona.avatar || linkedPersona.name}`,
                `${memberName}의 연결 페르소나 설명이 매우 길어 챗로그용 사본은 앞부분 240KB까지만 사용합니다.`,
            );
        }
        const patch = {};
        if (JSON.stringify(members) !== JSON.stringify(room.members || [])) patch.members = members;
        if (JSON.stringify(personaSnapshot) !== JSON.stringify(room.persona || {})) patch.persona = personaSnapshot;
        if (JSON.stringify(memberPersonas) !== JSON.stringify(room.memberPersonas || {})) {
            patch.memberPersonas = memberPersonas;
        }
        if (!Object.keys(patch).length) continue;
        if (truncatedNames.length) {
            warnCardSyncOnce(
                `cards:${room.id}:${truncatedNames.join('|')}`,
                `${truncatedNames.join(', ')} 카드가 매우 길어 챗로그용 사본은 캐릭터당 앞부분 240KB까지만 사용합니다.`,
            );
        }
        try {
            const updated = await api('/room/update', { roomId: room.id, ...patch });
            Object.assign(room, updated);
        } catch (error) {
            console.warn(`[chatlog] ${room.name || room.id} 카드 동기화 실패 — 다른 방과 연결 프로필 처리는 계속합니다.`, error);
            warnCardSyncOnce(
                `sync-error:${room.id}:${error.message}`,
                `${room.name || '방'}의 캐릭터 카드 동기화만 실패했어요. 다른 챗로그 기능은 계속 실행됩니다: ${error.message}`,
            );
        }
    }
}

// ── 상태 ──────────────────────────────────────────────────
let state = { rooms: {}, posts: {} };
let view = { screen: 'rooms', roomId: null };
let defaultSchedule = {
    activeFrom: 8,
    activeTo: 24,
    cutIntervalHours: 2,
    maxSilenceHours: 12,
    jitter: true,
};

// ═══════════ 확장 탭 설정 ═══════════
const SETTINGS_HTML = `
<div class="chatlog-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>챗로그</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content chatlog-settings-grid" style="display:none">
      <div class="chatlog-setting-section">생성 연결</div>

      <div class="chatlog-setting-field">
        <span class="chatlog-setting-label">텍스트 생성</span>
        <div class="chatlog-setting-control chatlog-fixed-provider">
          <span>ST 연결 프로필</span>
          <input id="chatlog-textmode" type="hidden" value="profile">
        </div>
      </div>
      <small class="chatlog-setting-help">게시 판단·댓글·반응은 선택한 Vertex AI 프로필의 모델과 인증만 사용합니다.</small>

      <div id="chatlog-profile-field" class="chatlog-setting-field">
        <label for="chatlog-profile">연결 프로필</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <select id="chatlog-profile" class="text_pole"></select>
          <button id="chatlog-profile-refresh" type="button" class="menu_button chatlog-icon-button fa-solid fa-rotate" title="목록 새로고침"></button>
        </div>
      </div>
      <div id="chatlog-profile-follow-field" class="chatlog-setting-field">
        <span class="chatlog-setting-label">자동 연결</span>
        <label class="checkbox_label chatlog-profile-follow chatlog-setting-control">
          <input id="chatlog-follow-profile" type="checkbox">
          <span>현재 선택 Vertex 프로필 사용</span>
        </label>
      </div>
      <small id="chatlog-profile-count" class="chatlog-setting-help"></small>

      <div class="chatlog-setting-field">
        <label for="chatlog-image-profile">이미지 연결 프로필</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <select id="chatlog-image-profile" class="text_pole"></select>
          <button id="chatlog-image-profile-refresh" type="button" class="menu_button chatlog-icon-button fa-solid fa-rotate" title="목록 새로고침"></button>
          <button id="chatlog-test-image" type="button" class="menu_button chatlog-mini-button">테스트</button>
        </div>
      </div>
      <small class="chatlog-setting-help">선택한 ST 프로필에서는 키·프로젝트 ID·리전만 가져옵니다. 프로필의 모델명은 이미지 요청에 사용하지 않습니다.</small>
      <small id="chatlog-image-profile-info" class="chatlog-setting-help"></small>

      <div class="chatlog-setting-field">
        <label for="chatlog-image-model">이미지 모델</label>
        <div class="chatlog-setting-control">
          <select id="chatlog-image-model" class="text_pole">
            <option value="gemini-3.1-flash-lite-image">나노바나나 2 Lite — 빠름 (권장)</option>
            <option value="gemini-3.1-flash-image">나노바나나 2 — 균형</option>
            <option value="gemini-3-pro-image">나노바나나 Pro — 고화질</option>
            <option value="gemini-2.5-flash-image">나노바나나 (구버전)</option>
            <option value="__custom">직접 입력</option>
          </select>
        </div>
      </div>
      <div class="chatlog-setting-field chatlog-custom-model-field">
        <span class="chatlog-setting-label">직접 입력</span>
        <div class="chatlog-setting-control">
          <input id="chatlog-image-model-custom" type="text" class="text_pole" placeholder="Vertex 이미지 모델 ID">
        </div>
      </div>
      <small class="chatlog-setting-help">기본값은 Vertex Express에서 검증된 gemini-3.1-flash-lite-image입니다. -preview 이름은 요청에 사용하지 않습니다.</small>
      <small id="chatlog-test-result" class="chatlog-setting-help"></small>

      <div class="chatlog-setting-section">게시 일정</div>

      <div class="chatlog-setting-field">
        <label>활동 시간</label>
        <div class="chatlog-setting-control chatlog-control-row chatlog-number-pair">
          <input id="chatlog-active-from" type="number" min="0" max="23" class="text_pole chatlog-short-input">
          <span>시</span><span>~</span>
          <input id="chatlog-active-to" type="number" min="1" max="24" class="text_pole chatlog-short-input">
          <span>시</span>
        </div>
      </div>
      <small class="chatlog-setting-help">이 시간 밖에서는 캐릭터가 올리지 않습니다.</small>

      <div class="chatlog-setting-field">
        <label for="chatlog-interval">판단 주기</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-interval" type="number" min="1" max="24" class="text_pole chatlog-short-input">
          <span>시간마다</span>
        </div>
      </div>
      <small class="chatlog-setting-help">성격과 상황에 따라 게시하거나 건너뜁니다.</small>

      <div class="chatlog-setting-field">
        <label for="chatlog-max-silence">최대 게시 공백</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-max-silence" type="number" min="1" max="72" class="text_pole chatlog-short-input">
          <span>활동 시간</span>
        </div>
      </div>
      <small id="chatlog-cost" class="chatlog-setting-help">비용 안내</small>

      <div class="chatlog-setting-field">
        <span class="chatlog-setting-label">시각 흔들기</span>
        <label class="checkbox_label chatlog-setting-control">
          <input id="chatlog-jitter" type="checkbox"><span>±25% 적용</span>
        </label>
      </div>

      <div class="chatlog-setting-section">사진 구성</div>

      <div class="chatlog-setting-field">
        <label>사진 유형 비율</label>
        <div class="chatlog-setting-control chatlog-control-row chatlog-number-pair chatlog-photo-ratio-row">
          <span>일상</span>
          <input id="chatlog-everyday-photo-chance" type="number" min="0" max="100" class="text_pole chatlog-short-input">
          <span>%</span>
          <span>셀카</span>
          <input id="chatlog-selfie-photo-chance" type="number" min="0" max="100" class="text_pole chatlog-short-input">
          <span>%</span>
        </div>
      </div>
      <small class="chatlog-setting-help">두 값은 자동으로 합계 100%가 됩니다. 최근 기록의 비율을 보정해 설정값에 가깝게 유지합니다. 캐릭터 카드 성격에 따라 셀카 비율이 최대 ±15% 보정되며, 높은 비율의 유형은 더 오래 이어질 수 있습니다.</small>

      <div class="chatlog-setting-field">
        <label for="chatlog-partner-selfie-chance">연결 페르소나 동반</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-partner-selfie-chance" type="number" min="0" max="100" class="text_pole chatlog-short-input">
          <span>셀카 중 %</span>
        </div>
      </div>
      <small class="chatlog-setting-help">셀카가 선택됐을 때 해당 캐릭터에게 연결된 페르소나와 함께 찍을 비율입니다. 최근 셀카 기록의 동반 비율과 연속 한도를 함께 보정합니다. 0%면 혼자만 찍고, 참조 프사가 없으면 자동으로 혼자 셀카로 전환됩니다.</small>

      <div class="chatlog-setting-field">
        <label for="chatlog-room-meetup-chance">같은 방 공동 장면</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-room-meetup-chance" type="number" min="0" max="100" class="text_pole chatlog-short-input">
          <span>슬롯 중 %</span>
        </div>
      </div>
      <small class="chatlog-setting-help">같은 방 캐릭터 2~3명이 같은 시간대에 카페·식사·산책·쇼핑·운동 같은 한 장소에 함께 있을 확률입니다. 관계와 성격에 따라 참석자를 고르며, 모두가 꼭 게시하지는 않습니다.</small>

      <div class="chatlog-setting-field">
        <label for="chatlog-shared-scene-post-chance">추가 참석자 게시</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-shared-scene-post-chance" type="number" min="0" max="100" class="text_pole chatlog-short-input">
          <span>공동 장면 중 %</span>
        </div>
      </div>
      <small class="chatlog-setting-help">공동 장면의 첫 게시자 외 참석자가 같은 장소를 자기 시점으로 이어 올릴 확률입니다. 배경과 시간은 공유하고 사진 구도·피사체는 다르게 만듭니다.</small>

      <div class="chatlog-setting-section">댓글과 반응</div>

      <div class="chatlog-setting-field">
        <label>댓글 지연</label>
        <div class="chatlog-setting-control chatlog-control-row chatlog-number-pair">
          <input id="chatlog-delay-min" type="number" min="0" max="600" class="text_pole chatlog-short-input">
          <span>~</span>
          <input id="chatlog-delay-max" type="number" min="1" max="600" class="text_pole chatlog-short-input">
          <span>분</span>
        </div>
      </div>

      <div class="chatlog-setting-field">
        <label for="chatlog-char-comment-chance">캐릭터끼리 댓글</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-char-comment-chance" type="number" min="0" max="100" class="text_pole chatlog-short-input">
          <span>% 확률</span>
        </div>
      </div>
      <small class="chatlog-setting-help">이모지는 항상 남기고, 설정한 확률로 댓글도 답니다.</small>

      <div class="chatlog-setting-section">자동 실행 상태</div>
      <div id="chatlog-runtime-status" class="chatlog-runtime-status">불러오는 중...</div>
      <div class="chatlog-setting-field">
        <span class="chatlog-setting-label">상세 디버그</span>
        <label class="checkbox_label chatlog-setting-control">
          <input id="chatlog-debug-enabled" type="checkbox"><span>최근 AI 응답 기록 허용</span>
        </label>
      </div>
      <small class="chatlog-setting-help">기본값은 꺼짐입니다. 오류를 확인할 때만 켜고, 확인 후 다시 끄면 메모리에 보관된 상세 응답도 즉시 지웁니다.</small>
      <div class="chatlog-setting-tools">
        <button id="chatlog-status-refresh" type="button" class="menu_button chatlog-mini-button">상태 새로고침</button>
      </div>

      <div class="chatlog-setting-section">저장과 정리</div>

      <div class="chatlog-setting-field">
        <span class="chatlog-setting-label">자동 삭제</span>
        <label class="checkbox_label chatlog-setting-control">
          <input id="chatlog-autoclean" type="checkbox"><span>지난 기록 자동 삭제</span>
        </label>
      </div>
      <div class="chatlog-setting-field">
        <label for="chatlog-cleandays">보관 기간</label>
        <div class="chatlog-setting-control chatlog-control-row">
          <input id="chatlog-cleandays" type="number" min="0" max="30" class="text_pole chatlog-short-input">
          <span>일</span>
        </div>
      </div>
      <div class="chatlog-setting-field">
        <span class="chatlog-setting-label">보관 예외</span>
        <label class="checkbox_label chatlog-setting-control">
          <input id="chatlog-keepsaved" type="checkbox"><span>저장 표시한 기록 유지</span>
        </label>
      </div>
      <small class="chatlog-setting-help">사진과 하루로그 영상도 함께 정리합니다. 0일이면 오늘 기록만 남습니다.</small>
      <div class="chatlog-setting-tools">
        <button id="chatlog-cleannow" type="button" class="menu_button chatlog-mini-button">지금 정리</button>
      </div>

      <div class="chatlog-actions">
        <button id="chatlog-save" type="button" class="menu_button">저장</button>
        <button id="chatlog-open" type="button" class="menu_button">챗로그 열기</button>
        <button id="chatlog-reload" type="button" class="menu_button chatlog-icon-button" title="서버의 ai.js 다시 읽기">↻</button>
      </div>
    </div>
  </div>
</div>`;

function getConnectionManagerSettings() {
    const c = ctx();
    return c?.extensionSettings?.connectionManager
        || c?.extensionSettings?.['connection-manager']
        || window.extension_settings?.connectionManager
        || {};
}

function getProfiles() {
    const cm = getConnectionManagerSettings();
    return Array.isArray(cm.profiles) ? cm.profiles : [];
}

function getActiveConnectionProfile() {
    const cm = getConnectionManagerSettings();
    return getProfiles().find(profile => String(profile.id) === String(cm.selectedProfile)) || null;
}

// 서버에 저장된 프로필 이름. 목록 로딩이 늦어도 이 값은 안 잃는다.
let savedProfileName = '';
let savedImageProfileName = '';

function refreshProfileSelect(selected) {
    const allProfiles = getProfiles();
    const profiles = allProfiles.filter(isVertexProfile);
    const $sel = $('#chatlog-profile');

    if (selected !== undefined) savedProfileName = selected || '';
    const keep = selected !== undefined ? savedProfileName : ($sel.val() || savedProfileName);

    $sel.empty().append('<option value="">-- 선택 --</option>');
    profiles.forEach(p => $sel.append($('<option>').val(p.name).text(p.name)));

    // 목록에 아직 없어도 저장된 이름은 옵션으로 유지 (안 그러면 저장할 때 빈 값이 덮어씀)
    if (keep && !profiles.some(p => p.name === keep) && !allProfiles.length) {
        $sel.append($('<option>').val(keep).text(`${keep} (목록 로딩 대기)`));
    }
    const selectedName = profiles.some(profile => profile.name === keep)
        ? keep
        : profiles[0]?.name || '';
    if (selectedName) $sel.val(selectedName);
    savedProfileName = selectedName || (!allProfiles.length ? keep : '');

    $('#chatlog-profile-count').text(profiles.length
        ? `${profiles.length}개 Vertex 프로필 감지됨`
        : allProfiles.length
            ? 'Vertex AI 연결 프로필이 없습니다'
            : '프로필 목록 로딩 중...');
    return profiles;
}

function profileModel(profile) {
    return String(profile?.model || '');
}

function isVertexProfile(profile) {
    return (profile?.['api-source'] || profile?.api) === 'vertexai';
}

function refreshImageProfileSelect(selected) {
    const allProfiles = getProfiles();
    const profiles = allProfiles.filter(isVertexProfile);
    const $sel = $('#chatlog-image-profile');

    if (selected !== undefined) savedImageProfileName = selected || '';
    let keep = selected !== undefined
        ? savedImageProfileName
        : ($sel.val() || savedImageProfileName);
    if (!keep) {
        const textProfile = profiles.find(profile => profile.name === $('#chatlog-profile').val());
        keep = (isVertexProfile(textProfile) ? textProfile : null)?.name
            || profiles.find(isVertexProfile)?.name
            || '';
    }

    $sel.empty().append('<option value="">-- 이미지 프로필 선택 --</option>');
    profiles.forEach(profile => {
        const model = profileModel(profile);
        const suffix = model ? ` · ${model}` : '';
        $sel.append($('<option>').val(profile.name).text(`${profile.name}${suffix}`));
    });

    if (keep && !profiles.some(profile => profile.name === keep) && !allProfiles.length) {
        $sel.append($('<option>').val(keep).text(`${keep} (목록 로딩 대기)`));
    }
    const selectedName = profiles.some(profile => profile.name === keep)
        ? keep
        : profiles[0]?.name || '';
    if (selectedName) $sel.val(selectedName);
    savedImageProfileName = selectedName || (!allProfiles.length ? keep : '');
    updateImageProfileInfo();
    return profiles;
}

function updateImageProfileInfo() {
    const name = $('#chatlog-image-profile').val();
    const profile = getProfiles().find(item => item.name === name);
    if (!name) {
        $('#chatlog-image-profile-info').text('Vertex 인증 정보가 저장된 ST 연결 프로필을 골라주세요.');
        return;
    }
    if (!profile) {
        $('#chatlog-image-profile-info').text(`${name} 프로필 정보를 불러오는 중입니다.`);
        return;
    }
    const model = profileModel(profile) || '모델 미지정';
    const warning = isVertexProfile(profile) ? '' : ' · ⚠ Vertex AI 프로필 필요';
    $('#chatlog-image-profile-info').text(
        `${profile.name} · 인증 정보만 사용 · 프로필 모델 ${model}은 무시${warning}`,
    );
}

function setImageModel(value) {
    const $select = $('#chatlog-image-model');
    const model = String(value || 'gemini-3.1-flash-lite-image').trim();
    const known = $select.find('option').map((_, option) => option.value).get();
    const custom = !!model && !known.includes(model);
    if (custom) {
        $select.val('__custom');
        $('#chatlog-image-model-custom').val(model);
    } else {
        $select.val(model || 'gemini-3.1-flash-lite-image');
        $('#chatlog-image-model-custom').val('');
    }
    $('.chatlog-custom-model-field').toggle(custom);
}

function readImageModel() {
    const selected = $('#chatlog-image-model').val();
    return selected === '__custom'
        ? $('#chatlog-image-model-custom').val().trim()
        : selected;
}

const FALLBACK_SETTINGS = {
    profileName: '', imageProfileName: '',
    imageModel: 'gemini-3.1-flash-lite-image',
    selfiePhotoChance: 50,
    partnerSelfieChance: 45,
    roomMeetupChance: 28,
    sharedScenePostChance: 55,
    commentDelayMinMin: 1, commentDelayMaxMin: 30,
    autoCleanup: false, cleanupAfterDays: 1, keepSaved: true,
    debugEnabled: false,
    textMode: 'profile',
    followActiveProfile: true,
    characterCommentChance: 30,
};

function toggleTextMode() {
    $('#chatlog-profile-field').show();
    $('#chatlog-profile-follow-field').show();
    $('#chatlog-profile-count').show();
}

async function syncActiveConnectionProfile(profileName = null) {
    if (!$('#chatlog-follow-profile').is(':checked')) return;
    const active = profileName
        ? getProfiles().find(profile => profile.name === profileName)
        : getActiveConnectionProfile();
    if (!active?.name) return;
    if (!isVertexProfile(active)) {
        refreshProfileSelect();
        $('#chatlog-profile-count').text('현재 활성 프로필은 Vertex가 아니므로 저장된 Vertex 프로필을 사용합니다');
        return;
    }
    refreshProfileSelect(active.name);
    try {
        await api('/settings', { profileName: active.name, followActiveProfile: true });
    } catch (e) {
        console.warn('[chatlog] 활성 연결 프로필 동기화 실패', e);
    }
}

function statusTime(timestamp) {
    return timestamp
        ? new Date(timestamp).toLocaleString('ko-KR', { hour12: false })
        : '아직 없음';
}

function compactRuntimeError(message) {
    const normalized = String(message || '').replace(/\s+/g, ' ').trim();
    const jsonStart = normalized.indexOf(': {');
    const summary = jsonStart >= 0 ? normalized.slice(0, jsonStart) : normalized;
    return summary.length > 180 ? `${summary.slice(0, 177)}…` : summary;
}

async function loadRuntimeStatus() {
    const $status = $('#chatlog-runtime-status');
    if (!$status.length) return;
    try {
        const status = await api('/status');
        $status.html([
            `<div><b>다음 판단</b><span>${esc(statusTime(status.nextSlotAt))}</span></div>`,
            `<div><b>마지막 성공</b><span>${esc(statusTime(status.lastSuccessAt))}${status.lastSuccess ? ` · ${esc(status.lastSuccess)}` : ''}</span></div>`,
            `<div><b>마지막 오류</b><span class="${status.lastError ? 'error' : ''}" title="${escAttr(status.lastError || '')}">${status.lastError ? `${esc(statusTime(status.lastErrorAt))} · ${esc(compactRuntimeError(status.lastError))}` : '없음'}</span></div>`,
            status.lastNotice
                ? `<div><b>최근 안내</b><span>${esc(status.lastNotice)}</span></div>`
                : '',
            `<div><b>작업 큐</b><span>대기 ${Number(status.pendingJobs || 0)}개 · 재시도 ${Number(status.retryingJobs || 0)}개</span></div>`,
            `<div><b>건너뛴 밀린 슬롯</b><span>${Number(status.skippedMissedSlots || 0)}개</span></div>`,
        ].filter(Boolean).join(''));
    } catch (error) {
        $status.html(`<div><b>상태 오류</b><span class="error">${esc(error.message)}</span></div>`);
    }
}

async function loadSettingsUi() {
    let s = FALLBACK_SETTINGS;
    try {
        s = { ...FALLBACK_SETTINGS, ...(await api('/settings')) };
    } catch (e) {
        // 서버 플러그인이 아직 안 붙었어도 UI는 정상적으로 채운다
        console.warn('[chatlog] 설정 불러오기 실패 — 기본값 사용', e);
        $('#chatlog-profile-count').text('서버 플러그인 응답 없음 (plugins/chatlog 확인)');
    }
    $('#chatlog-follow-profile').prop('checked', s.followActiveProfile !== false);
    const activeProfile = getActiveConnectionProfile();
    const activeVertexProfile = isVertexProfile(activeProfile) ? activeProfile : null;
    refreshProfileSelect(s.followActiveProfile !== false && activeVertexProfile?.name
        ? activeVertexProfile.name
        : s.profileName);
    if (s.followActiveProfile !== false
        && activeVertexProfile?.name
        && activeVertexProfile.name !== s.profileName) {
        try {
            await api('/settings', { profileName: activeVertexProfile.name, followActiveProfile: true });
        } catch (e) {
            console.warn('[chatlog] 활성 연결 프로필 초기 동기화 실패', e);
        }
    }

    refreshImageProfileSelect(s.imageProfileName);
    setImageModel(s.imageModel);
    $('#chatlog-textmode').val('profile');
    toggleTextMode();
    $('#chatlog-delay-min').val(s.commentDelayMinMin);
    $('#chatlog-delay-max').val(s.commentDelayMaxMin);
    $('#chatlog-char-comment-chance').val(s.characterCommentChance ?? 30);
    const selfiePhotoChance = Math.max(0, Math.min(100,
        Number(s.selfiePhotoChance ?? 50)));
    $('#chatlog-selfie-photo-chance').val(selfiePhotoChance);
    $('#chatlog-everyday-photo-chance').val(100 - selfiePhotoChance);
    $('#chatlog-partner-selfie-chance').val(Math.max(0, Math.min(100,
        Number(s.partnerSelfieChance ?? 45))));
    $('#chatlog-room-meetup-chance').val(Math.max(0, Math.min(100,
        Number(s.roomMeetupChance ?? 28))));
    $('#chatlog-shared-scene-post-chance').val(Math.max(0, Math.min(100,
        Number(s.sharedScenePostChance ?? 55))));
    $('#chatlog-autoclean').prop('checked', !!s.autoCleanup);
    $('#chatlog-cleandays').val(s.cleanupAfterDays);
    $('#chatlog-keepsaved').prop('checked', !!s.keepSaved);
    $('#chatlog-debug-enabled').prop('checked', s.debugEnabled === true);

    defaultSchedule = {
        ...defaultSchedule,
        ...(JSON.parse(localStorage.getItem('chatlog_schedule') || 'null') || {}),
    };
    $('#chatlog-active-from').val(defaultSchedule.activeFrom);
    $('#chatlog-active-to').val(defaultSchedule.activeTo);
    $('#chatlog-interval').val(defaultSchedule.cutIntervalHours);
    $('#chatlog-max-silence').val(defaultSchedule.maxSilenceHours);
    $('#chatlog-jitter').prop('checked', defaultSchedule.jitter);
    updateCostHint();
    await loadRuntimeStatus();
}

function updateCostHint() {
    const from = Number($('#chatlog-active-from').val()) || 8;
    const to = Number($('#chatlog-active-to').val()) || 24;
    const iv = Number($('#chatlog-interval').val()) || 2;
    const slots = Math.max(0, Math.floor((to - from) / iv));
    $('#chatlog-cost').text(`하루 약 ${slots}번 판단 · 판단용 텍스트 요청은 인원마다, 이미지는 실제 게시자만 생성합니다.`);
}

async function saveSettingsUi() {
    defaultSchedule = {
        activeFrom: Number($('#chatlog-active-from').val()),
        activeTo: Number($('#chatlog-active-to').val()),
        cutIntervalHours: Number($('#chatlog-interval').val()),
        maxSilenceHours: Math.max(
            Number($('#chatlog-interval').val()),
            Number($('#chatlog-max-silence').val()) || 12,
        ),
        jitter: $('#chatlog-jitter').is(':checked'),
    };
    localStorage.setItem('chatlog_schedule', JSON.stringify(defaultSchedule));

    await api('/settings', {
        profileName: $('#chatlog-profile').val(),
        imageProfileName: $('#chatlog-image-profile').val(),
        imageModel: readImageModel(),
        selfiePhotoChance: Math.max(0, Math.min(100,
            Number($('#chatlog-selfie-photo-chance').val()) || 0)),
        partnerSelfieChance: Math.max(0, Math.min(100,
            Number($('#chatlog-partner-selfie-chance').val()) || 0)),
        roomMeetupChance: Math.max(0, Math.min(100,
            Number($('#chatlog-room-meetup-chance').val()) || 0)),
        sharedScenePostChance: Math.max(0, Math.min(100,
            Number($('#chatlog-shared-scene-post-chance').val()) || 0)),
        followActiveProfile: $('#chatlog-follow-profile').is(':checked'),
        textMode: 'profile',
        commentDelayMinMin: Number($('#chatlog-delay-min').val()),
        commentDelayMaxMin: Number($('#chatlog-delay-max').val()),
        characterCommentChance: Math.max(0, Math.min(100,
            Number($('#chatlog-char-comment-chance').val()) || 0)),
        userPersonaName: ctx().name1 || '',
        autoCleanup: $('#chatlog-autoclean').is(':checked'),
        cleanupAfterDays: Number($('#chatlog-cleandays').val()),
        keepSaved: $('#chatlog-keepsaved').is(':checked'),
        debugEnabled: $('#chatlog-debug-enabled').is(':checked'),
    });


    const { rooms } = await api('/state');
    for (const room of Object.values(rooms)) {
        await api('/room/update', { roomId: room.id, schedule: defaultSchedule });
    }
    notify('success', '챗로그 설정 저장됨');
}

// ═══════════ 오버레이 ═══════════
let $overlay = null;
let openingChatlog = null;

function unreadCount(snapshot = state) {
    return Object.values(snapshot?.posts || {}).reduce((total, posts) =>
        total + (posts || []).reduce((count, post) =>
            count
            + (post.read ? 0 : 1)
            + (post.comments || []).filter(comment => !comment.read).length, 0), 0);
}

function updateQuickOpenBadge() {
    const count = unreadCount();
    const $badge = $('#chatlog-quick-badge');
    if (!$badge.length) return;
    $badge.text(count > 99 ? '99+' : String(count)).toggle(count > 0);
    $('#chatlog-quick-open').attr('aria-label',
        count ? `챗로그 열기, 새 기록 ${count}개` : '챗로그 열기');
}

function findHoneyPotAnchor() {
    const $roots = $('#send_form, #form_sheld');
    if (!$roots.length) return $();
    const isHoney = element => $(element).text().replace(/\uFE0F/g, '').trim() === '🍯';

    const $matches = $roots.find('*').filter(function () {
        if (this.id === 'chatlog-quick-open' || $(this).find('#chatlog-quick-open').length) return false;
        return isHoney(this);
    });
    const $leaf = $matches.filter(function () {
        return !$(this).find('*').filter((_, child) => isHoney(child)).length;
    }).first();
    if (!$leaf.length) return $();

    const $clickable = $leaf.closest('button, [role="button"], .interactable, .menu_button');
    return $clickable.length ? $clickable.first() : $leaf;
}

function placeQuickOpenButton($button) {
    const $honeyPot = findHoneyPotAnchor();
    if ($honeyPot.length) {
        if (!$button.next().is($honeyPot)) $button.insertBefore($honeyPot);
        $button.addClass('chatlog-near-honey');
        return true;
    }

    $button.removeClass('chatlog-near-honey');
    const $left = $('#leftSendForm').first();
    if ($left.length) {
        if (!$button.parent().is($left)) $button.prependTo($left);
        return true;
    }
    const $sendButton = $('#send_but').first();
    if ($sendButton.length) {
        if (!$button.next().is($sendButton)) $button.insertBefore($sendButton);
        return true;
    }
    const $host = $('#rightSendForm, #send_form').first();
    if ($host.length) {
        if (!$button.parent().is($host)) $button.prependTo($host);
        return true;
    }
    return false;
}

function ensureQuickOpenButton() {
    let $button = $('#chatlog-quick-open');
    if (!$button.length) {
        $button = $(`
          <button id="chatlog-quick-open" type="button" class="chatlog-quick-open"
            title="챗로그 열기" aria-label="챗로그 열기">
            <span class="chatlog-quick-face" aria-hidden="true">🙃</span>
            <span id="chatlog-quick-badge" class="chatlog-quick-badge" style="display:none"></span>
          </button>`);
        $button.on('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openChatlog();
        });
    }
    if (!placeQuickOpenButton($button)) return;
    updateQuickOpenBadge();
}

async function refreshQuickBadge() {
    if (document.hidden || $overlay) {
        updateQuickOpenBadge();
        return;
    }
    try {
        state = await api('/state');
        updateQuickOpenBadge();
    } catch { /* 서버가 재시작 중이면 다음 주기에 다시 확인 */ }
}

function mountChatlog(loadError = null) {
    if ($overlay) return;
    $overlay = $(`
      <div class="chatlog-overlay">
        <div class="chatlog-app">
          <header class="chatlog-head">
            <span class="chatlog-back fa-solid fa-chevron-left"></span>
            <span class="chatlog-title">chatlog</span>
            <span class="chatlog-close fa-solid fa-xmark"></span>
          </header>
          <main class="chatlog-body"></main>
        </div>
      </div>`);

    // 공식 토스트와 동일한 최상위 body 레이어에서 z-index로 순서를 정한다.
    document.body.appendChild($overlay[0]);

    $overlay.on('click', e => { if (e.target === $overlay[0]) closeChatlog(); });
    $overlay.find('.chatlog-close').on('click', closeChatlog);
    $overlay.find('.chatlog-back').on('click', () => { view.screen = 'rooms'; render(); });

    view = { screen: 'rooms', roomId: null };
    if (loadError) {
        $overlay.find('.chatlog-body').html(
            `<div class="chatlog-empty">서버 플러그인에 연결하지 못했어요<br>` +
            `<small>plugins/chatlog 설치와 ST 재시작을 확인해주세요<br>${esc(loadError.message)}</small></div>`);
    } else {
        render();
    }
}

async function openChatlog() {
    if ($overlay) return;
    if (openingChatlog) return openingChatlog;

    $('#chatlog-quick-open').addClass('busy');
    openingChatlog = (async () => {
        let loadError = null;
        try {
            state = await api('/state');
            await syncRoomCharacterCards();
        } catch (error) {
            loadError = error;
        }
        mountChatlog(loadError);
        updateQuickOpenBadge();
    })().finally(() => {
        openingChatlog = null;
        $('#chatlog-quick-open').removeClass('busy');
    });
    return openingChatlog;
}

function closeChatlog() { $overlay?.remove(); $overlay = null; }

let refreshInFlight = null;
function preloadImage(src, timeoutMs = 2500) {
    if (!src) return Promise.resolve();
    return new Promise(resolve => {
        const image = new Image();
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        image.onload = finish;
        image.onerror = finish;
        image.decoding = 'async';
        image.src = src;
        if (image.complete) finish();
    });
}

async function preloadVisibleFeedImages() {
    if (view.screen !== 'feed') return;
    const room = state.rooms[view.roomId];
    if (!room) return;
    const { pages, pageIndex } = feedState(room);
    const sources = pages[pageIndex]?.items
        ?.filter(item => item.kind === 'post' && item.post?.image)
        .map(item => item.post.image) || [];
    await Promise.all([...new Set(sources)].map(src => preloadImage(src)));
}

async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
        const $body = $overlay?.find('.chatlog-body');
        const scrollTop = $body?.scrollTop() || 0;
        try {
            state = await api('/state');
            await syncRoomCharacterCards();
        } catch (e) {
            $body?.html(
                `<div class="chatlog-empty">서버 플러그인에 연결하지 못했어요<br>` +
                `<small>plugins/chatlog 설치와 ST 재시작을 확인해주세요<br>${esc(e.message)}</small></div>`);
            return;
        }
        await preloadVisibleFeedImages();
        updateQuickOpenBadge();
        render({ preserveScroll: true, scrollTop });
    })().finally(() => {
        refreshInFlight = null;
    });
    return refreshInFlight;
}

function render(options = {}) {
    if (!$overlay) return;
    $overlay.find('.chatlog-back').toggleClass('hidden', view.screen === 'rooms');
    view.screen === 'rooms' ? renderRooms() : renderFeed(options);
}

async function confirmRoomDeletion(room) {
    const c = ctx();
    if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE?.CONFIRM !== undefined) {
        const $message = $('<div class="chatlog-room-delete-confirm"></div>');
        $('<p>').text('해당 챗로그 방을 없애겠습니까?').appendTo($message);
        $('<small>').text(`“${room.name}” 방의 게시물과 사진도 함께 삭제됩니다.`).appendTo($message);
        return Boolean(await c.callGenericPopup(
            $message[0],
            c.POPUP_TYPE.CONFIRM,
            '',
            { okButton: '네', cancelButton: '아니요' },
        ));
    }
    return window.confirm('해당 챗로그 방을 없애겠습니까?\n방의 게시물과 사진도 함께 삭제됩니다.');
}

async function deleteRoom(room, $button) {
    if (!await confirmRoomDeletion(room)) return;
    if ($button.prop('disabled')) return;
    $button.prop('disabled', true).addClass('busy');
    try {
        await api('/room/delete', { roomId: room.id });
        delete state.rooms[room.id];
        delete state.posts[room.id];
        if (view.roomId === room.id) view = { screen: 'rooms', roomId: null };
        render();
        notify('success', '챗로그 방을 삭제했어요.');
    } catch (error) {
        notify('error', `방 삭제 실패: ${error.message}`);
        $button.prop('disabled', false).removeClass('busy');
    }
}

// ── 로그 목록 ─────────────────────────────────────────────
function renderRooms() {
    const $body = $overlay.find('.chatlog-body');
    const $b = $('<div class="chatlog-render-buffer"></div>');
    $overlay.find('.chatlog-title').text('chatlog');

    const rooms = Object.values(state.rooms);
    if (!rooms.length) {
        $b.append('<div class="chatlog-empty">아직 로그가 없어요.<br><small>아래에서 새 로그를 만들어보세요.</small></div>');
    }

    for (const room of rooms) {
        const posts = state.posts[room.id] || [];
        const last = posts[posts.length - 1];
        const unread = posts.reduce((n, p) =>
            n + (p.read ? 0 : 1) + (p.comments || []).filter(c => !c.read).length, 0);

        const $card = $(`
          <div class="chatlog-roomcard">
            <div class="chatlog-roomthumb">${last?.image ? `<img src="${escAttr(last.image)}">` : '<span class="fa-solid fa-camera"></span>'}</div>
            <div class="chatlog-roommeta">
              <div class="chatlog-roomname">${esc(room.name)}</div>
              <div class="chatlog-roomsub">${room.members.length}명 · ${last ? timeLabel(last.createdAt) : '기록 없음'}</div>
            </div>
            <div class="chatlog-room-actions">
              ${unread ? `<span class="chatlog-badge">${unread}</span>` : ''}
              <button type="button" class="chatlog-room-delete" title="방 삭제" aria-label="${escAttr(room.name)} 방 삭제">&times;</button>
            </div>
          </div>`);
        $card.on('click', () => {
            markRead(room.id);
            view = { screen: 'feed', roomId: room.id };
            render();
        });
        $card.find('.chatlog-room-delete').on('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            await deleteRoom(room, $(event.currentTarget));
        });
        $b.append($card);
    }

    const $new = $('<div class="chatlog-newroom"><span class="fa-solid fa-plus"></span> 새 로그 만들기</div>');
    $new.on('click', createRoomFlow);
    $b.append($new);
    $body.empty().append($b.children());
}

// ── 피드: 슬롯 페이지 (실물 셋로그 구조) ──────────────────
const REACT_EMOJIS = ['❤️', '😂', '🥹', '😮', '😢', '😡', '👏', '🔥', '👍', '👀'];

const hhmm = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const slotTimestamp = post => post.slotAt ?? post.createdAt;
const dateFromDayKey = key => {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(year, month - 1, day);
};

function feedState(room) {
    view.feed ??= {};
    const f = view.feed;
    const posts = (state.posts[room.id] || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    const isGroup = room.members.length > 1;
    const recordedSlots = isGroup ? (room.slotHistory || []) : [];

    const days = [...new Set([
        ...posts.map(p => dayKey(slotTimestamp(p))),
        ...recordedSlots.map(dayKey),
    ])];
    days.sort((a, b) => dateFromDayKey(a) - dateFromDayKey(b));
    if (!days.includes(dayKey(Date.now()))) days.push(dayKey(Date.now()));
    if (!f.day || !days.includes(f.day)) f.day = days[days.length - 1];

    const dayPosts = posts.filter(p => dayKey(slotTimestamp(p)) === f.day);
    const daySlotTimes = recordedSlots.filter(ts => dayKey(ts) === f.day);
    const slots = [...new Set([
        ...dayPosts.map(p => new Date(slotTimestamp(p)).getHours()),
        ...daySlotTimes.map(ts => new Date(ts).getHours()),
    ])].sort((a, b) => a - b);
    if (f.slot == null || !slots.includes(f.slot)) f.slot = slots[slots.length - 1];

    const people = [
        {
            id: 'user',
            name: personaForRoom(room).name,
            avatar: avatarUrl('user', room),
        },
        ...room.members.map(m => ({
            id: m.avatar,
            name: characterName(room, m.avatar, m.name),
            avatar: avatarUrl(m.avatar, room),
        })),
    ];

    // 넘김 단위는 게시물 한 장이 아니라 시간대 한 페이지다.
    // 단톡방은 안 올린 참여자도 빈 슬롯으로 두어 같은 시간대를 한눈에 보여준다.
    const pages = slots.map(hour => {
        const hourPosts = dayPosts.filter(p => new Date(slotTimestamp(p)).getHours() === hour);
        const pageSlotAt = daySlotTimes.find(ts => new Date(ts).getHours() === hour)
            ?? slotTimestamp(hourPosts[0] || { createdAt: Date.now() });
        const items = [];
        for (const person of people) {
            const ownPosts = hourPosts.filter(p => p.author === person.id);
            if (ownPosts.length) {
                ownPosts.forEach((post, index) => items.push({
                    key: `post:${post.id}`,
                    kind: 'post',
                    post,
                    person,
                    duplicateIndex: index,
                }));
            } else if (isGroup) {
                items.push({
                    key: `empty:${hour}:${person.id}`,
                    kind: 'empty',
                    person,
                    timestamp: pageSlotAt,
                });
            }
        }
        return { key: `hour:${hour}`, hour, items };
    });

    const pageIndex = Math.max(0, pages.findIndex(page => page.hour === f.slot));
    return { posts, days, dayPosts, slots, pages, pageIndex, f };
}

function reuseStableImages($oldCard, $newCard) {
    const oldImages = new Map();
    $oldCard.find('img').each((_, element) => {
        const $image = $(element);
        const key = `${element.className}\u0000${$image.attr('src') || ''}`;
        if (!oldImages.has(key)) oldImages.set(key, []);
        oldImages.get(key).push($image);
    });
    $newCard.find('img').each((_, element) => {
        const $newImage = $(element);
        const key = `${element.className}\u0000${$newImage.attr('src') || ''}`;
        const bucket = oldImages.get(key);
        const $oldImage = bucket?.shift();
        if ($oldImage?.length) $newImage.replaceWith($oldImage.detach());
    });
}

function renderFeed(options = {}) {
    const room = state.rooms[view.roomId];
    if (!room) { view.screen = 'rooms'; return render(); }

    $overlay.find('.chatlog-title').text(room.name);
    const $body = $overlay.find('.chatlog-body');
    const $b = $('<div class="chatlog-render-buffer"></div>');
    const preserveScroll = options.preserveScroll === true;
    const retainedScrollTop = preserveScroll
        ? Number(options.scrollTop ?? $body.scrollTop() ?? 0)
        : 0;
    const commitBody = () => {
        const body = $body[0];
        if (!body) return;
        const fragment = document.createDocumentFragment();
        for (const child of $b.children().toArray()) fragment.appendChild(child);
        body.replaceChildren(fragment);
        if (!preserveScroll) return;
        const restore = () => {
            if (!body.isConnected) return;
            const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
            body.scrollTop = Math.min(retainedScrollTop, maxScroll);
        };
        // 같은 페인트 안에서 먼저 복원하고, 이미지·글꼴 레이아웃 뒤 한 번 더 고정한다.
        restore();
        requestAnimationFrame(restore);
    };

    const { days, dayPosts, slots, pages, pageIndex, f } = feedState(room);

    // 상단 바: 날짜 이동 + 올리기/하루로그
    const di = days.indexOf(f.day);
    const dateLabel = dateFromDayKey(f.day)
        .toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    const relationshipReady = room.relationshipGraph?.status === 'ready';
    const relationshipTitle = relationshipReady
        ? `관계 직접 설정${room.relationshipGraph.summary ? ` · ${room.relationshipGraph.summary}` : ''}`
        : '관계 설정 필요';
    const $top = $(`
      <div class="chatlog-slotbar">
        <span class="chatlog-nav prev fa-solid fa-chevron-left${di <= 0 ? ' off' : ''}"></span>
        <span class="chatlog-date">${dateLabel}</span>
        <span class="chatlog-nav next fa-solid fa-chevron-right${di >= days.length - 1 ? ' off' : ''}"></span>
        <span class="chatlog-slotbtn persona fa-solid fa-user-pen" title="표시 페르소나 변경"></span>
        <span class="chatlog-slotbtn relationships fa-solid fa-people-arrows${relationshipReady ? '' : ' stale'}" title="${escAttr(relationshipTitle)}"></span>
        <span class="chatlog-slotbtn upload fa-solid fa-camera" title="올리기"></span>
        <span class="chatlog-slotbtn daylog fa-solid fa-clapperboard" title="하루로그"></span>
      </div>`);
    $top.find('.prev').on('click', () => {
        if (di > 0) {
            f.day = days[di - 1];
            f.slot = null;
            render();
        }
    });
    $top.find('.next').on('click', () => {
        if (di < days.length - 1) {
            f.day = days[di + 1];
            f.slot = null;
            render();
        }
    });
    $top.find('.persona').on('click', () => changeRoomDisplayPersona(room));
    $top.find('.relationships').on('click', () => editRoomRelationships(room));
    $top.find('.upload').on('click', () => uploadSheet(room));
    $top.find('.daylog').on('click', () => dayLogView(room, f.day));
    $b.append($top);

    if (!slots.length) {
        $b.append('<div class="chatlog-empty">이 날은 기록이 없어요.<br><small>카메라 버튼으로 지금 한 장 올려보세요.</small></div>');
        commitBody();
        return;
    }

    // 시간대 탭
    const $dots = $('<div class="chatlog-dots"></div>');
    slots.forEach(h => {
        const $d = $(`
          <button type="button" class="chatlog-dot${h === f.slot ? ' on' : ''}" title="${hourLabelShort(h)}">
            <span>${String(h).padStart(2, '0')}</span>
          </button>`);
        $d.on('click', () => {
            f.slot = h;
            f.motion = 'jump';
            render();
        });
        $dots.append($d);
    });
    $b.append($dots);

    const currentPage = pages[pageIndex];
    if (!currentPage) {
        commitBody();
        return;
    }

    const postCount = currentPage.items.filter(item => item.kind === 'post').length;
    const emptyCount = currentPage.items.filter(item => item.kind === 'empty').length;
    const $meta = $(`
      <div class="chatlog-slide-meta">
        <b>${String(currentPage.hour).padStart(2, '0')}:00</b>
        <span>${postCount}개 기록${emptyCount ? ` · ${emptyCount}칸 비어 있음` : ''}</span>
      </div>`);
    $b.append($meta);

    const goPage = delta => {
        const nextIndex = pageIndex + delta;
        if (nextIndex < 0 || nextIndex >= pages.length) return;
        f.slot = pages[nextIndex].hour;
        f.motion = delta > 0 ? 'next' : 'prev';
        render();
    };

    const $stage = $(`<div class="chatlog-stage motion-${f.motion || 'none'}"></div>`);
    for (const item of currentPage.items) {
        try {
            const $card = item.kind === 'post'
                ? slotCard(room, item.post)
                : placeholderCard(item.person.name, item.person.avatar);
            addSlideNavigation($card, {
                canPrev: pageIndex > 0,
                canNext: pageIndex < pages.length - 1,
                onPrev: () => goPage(-1),
                onNext: () => goPage(1),
            });
            $stage.append($card);
        } catch (e) {
            console.error('[chatlog] 카드 렌더 실패', item.key, e);
            $stage.append(`<div class="chatlog-rendererr">렌더 실패 (${esc(item.key)})<br>${esc(e.message)}</div>`);
        }
    }
    f.motion = 'none';
    $b.append($stage);
    const oldCards = new Map();
    $body.find('.chatlog-cardwrap[data-post-id]').each((_, element) => {
        const $element = $(element);
        oldCards.set(String($element.attr('data-post-id')), $element);
    });
    $stage.find('.chatlog-cardwrap[data-post-id]').each((_, element) => {
        const $newCard = $(element);
        const $oldCard = oldCards.get(String($newCard.attr('data-post-id')));
        if (!$oldCard) return;
        if ($oldCard.attr('data-render-key') === $newCard.attr('data-render-key')) {
            $newCard.replaceWith($oldCard.detach());
            return;
        }
        reuseStableImages($oldCard, $newCard);
    });
    commitBody();
}

function hourLabelShort(h) {
    return h < 12 ? `오전${h || 12}` : h === 12 ? '오후12' : `오후${h - 12}`;
}

function placeholderCard(name, avatar) {
    return $(`
      <div class="chatlog-cardwrap">
        <article class="chatlog-scard empty">
          <div class="chatlog-sc-top"><img src="${escAttr(avatar)}"><span>${esc(name)}</span></div>
          <div class="chatlog-sc-center">
            <div class="chatlog-empty-label">아직 기록 전</div>
          </div>
        </article>
      </div>`);
}

function addSlideNavigation($slide, { canPrev, canNext, onPrev, onNext }) {
    const $surface = $slide.find('.chatlog-scard').first();
    if (!$surface.length) return;

    const $prev = $(`<button type="button" class="chatlog-edge prev${canPrev ? '' : ' off'}" aria-label="이전 사진"></button>`);
    const $next = $(`<button type="button" class="chatlog-edge next${canNext ? '' : ' off'}" aria-label="다음 사진"></button>`);
    $surface.append($prev, $next);

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let suppressClickUntil = 0;

    if (canPrev) {
        $prev.on('click', () => {
            if (Date.now() < suppressClickUntil) return;
            onPrev();
        });
    }
    if (canNext) {
        $next.on('click', () => {
            if (Date.now() < suppressClickUntil) return;
            onNext();
        });
    }

    $surface.on('touchstart', e => {
        if ($(e.target).closest('.chatlog-sc-btn, textarea, input').length) return;
        const touch = e.originalEvent.touches?.[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
        tracking = true;
    });

    $surface.on('touchend', e => {
        if (!tracking) return;
        tracking = false;
        const touch = e.originalEvent.changedTouches?.[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) < 46 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
        // 스와이프 직후 브라우저가 합성하는 click으로 한 장 더 넘어가는 것을 막는다.
        suppressClickUntil = Date.now() + 450;
        if (dx < 0 && canNext) onNext();
        if (dx > 0 && canPrev) onPrev();
    });
}

function slotCard(room, p) {
    const name = characterName(room, p.author, p.authorName);
    const reacts = (p.reactions || []).map(r => {
        const rname = r.author === 'user'
            ? personaForRoom(room).name
            : characterName(room, r.author, r.authorName);
        return `<span class="chatlog-react" title="${escAttr(rname)}">
          <img class="chatlog-ravatar" src="${escAttr(avatarUrl(r.author, room))}" alt="">
          <span>${esc(r.emoji)}</span>
        </span>`;
    }).join('');
    const canReply = p.author !== 'user';

    const comments = p.comments.map(c => {
        const cname = characterName(room, c.author, c.authorName);
        return `
      <div class="chatlog-comment${c.read ? '' : ' unread'}">
        <img class="chatlog-cavatar" src="${escAttr(avatarUrl(c.author, room))}">
        <div class="chatlog-cbubble"><b>${esc(cname)}</b> ${esc(c.text)}</div>
      </div>`;
    }).join('');

    const $card = $(`
      <div class="chatlog-cardwrap">
        <article class="chatlog-scard${p.image ? ' has-photo' : ' empty'}">
          ${p.image ? `<img class="chatlog-sc-bg" src="${escAttr(p.image)}">` : ''}
          <div class="chatlog-sc-top"><img src="${escAttr(avatarUrl(p.author, room))}"><span>${esc(name)}</span></div>
          <div class="chatlog-sc-center">
            <div class="chatlog-sc-time${p.image ? '' : ' dim'}">${hhmm(p.createdAt)}</div>
            ${p.text ? `<div class="chatlog-sc-cap">${esc(p.text)}</div>` : ''}
          </div>
          <div class="chatlog-sc-corner">
            ${canReply ? '<span class="chatlog-sc-btn reply fa-solid fa-reply"></span>' : ''}
            <span class="chatlog-sc-btn smile">🙂</span>
          </div>
        </article>
        <div class="chatlog-reactrow">
          <div class="chatlog-reacts">${reacts}</div>
          <div class="chatlog-picker" style="display:none">
            ${REACT_EMOJIS.map(e => `<span class="chatlog-pick">${e}</span>`).join('')}
          </div>
          <div class="chatlog-postactions">
            ${p.image ? '<span class="chatlog-act" data-act="save"><span class="fa-solid fa-download"></span></span>' : ''}
            <span class="chatlog-act${p.saved ? ' on' : ''}" data-act="keep"><span class="fa-solid fa-thumbtack"></span></span>
            <span class="chatlog-act" data-act="del"><span class="fa-solid fa-trash"></span></span>
          </div>
        </div>
        ${comments ? `<div class="chatlog-comments">${comments}</div>` : ''}
      </div>`);
    $card.attr({
        'data-post-id': p.id,
        'data-render-key': JSON.stringify({
            image: p.image || '',
            text: p.text || '',
            saved: !!p.saved,
            reactions: (p.reactions || []).map(r => [r.author, r.emoji, r.createdAt]),
            comments: (p.comments || []).map(c => [c.id, c.author, c.text, !!c.read]),
        }),
    });

    $card.find('.smile').on('click', () => $card.find('.chatlog-picker').toggle());
    $card.find('.chatlog-pick').on('click', async function () {
        const $pick = $(this);
        if ($pick.hasClass('pending')) return;
        $pick.addClass('pending');
        try {
            await api('/react', { roomId: p.roomId, postId: p.id, emoji: $pick.text() });
            await refresh();
        } catch (e) {
            console.error('[chatlog] 이모지 반응 저장 실패', e);
            showError('이모지 반응 저장 실패: ' + e.message);
            $pick.removeClass('pending');
        }
    });
    $card.find('.reply').on('click', () => replySheet(room, p));

    $card.find('[data-act=save]').on('click', async () => {
        try { await downloadUrl(p.image, `chatlog_${dayKey(p.createdAt)}_${p.id}.png`); }
        catch (e) { notify('error', '저장 실패: ' + e.message); }
    });
    $card.find('[data-act=keep]').on('click', async () => {
        await api('/save', { roomId: p.roomId, postId: p.id, saved: !p.saved });
        refresh();
    });
    $card.find('[data-act=del]').on('click', async () => {
        if (!confirm('이 게시물을 지울까요? 사진도 같이 삭제됩니다.')) return;
        await api('/delete', { roomId: p.roomId, postId: p.id });
        refresh();
    });

    return $card;
}

// ── 답장 시트 ─────────────────────────────────────────────
function replySheet(room, post) {
    const recipientName = characterName(room, post.author, post.authorName);
    const $sheet = $(`
      <div class="chatlog-sheet">
        <div class="chatlog-sheet-inner">
          <div class="chatlog-sheet-title">${esc(recipientName)}에게 답장</div>
          ${post.text ? `<div class="chatlog-replyquote">${esc(post.text)}</div>` : ''}
          <textarea class="chatlog-input" rows="2" maxlength="200" placeholder="답글 남기기"></textarea>
          <div class="chatlog-sheet-actions">
            <div class="menu_button chatlog-cancel">취소</div>
            <div class="menu_button chatlog-send">보내기</div>
          </div>
        </div>
      </div>`);
    document.body.appendChild($sheet[0]);

    const close = () => $sheet.remove();
    $sheet.on('click', e => { if (e.target === $sheet[0]) close(); });
    $sheet.find('.chatlog-cancel').on('click', close);
    $sheet.find('.chatlog-send').on('click', async () => {
        const text = $sheet.find('.chatlog-input').val().trim();
        if (!text) return close();
        try {
            await api('/comment/user', { roomId: room.id, postId: post.id, text });
            close();
            refresh();
        } catch (e) {
            notify('error', '전송 실패: ' + e.message);
        }
    });
}

// ── 올리기 ────────────────────────────────────────────────
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('사진을 읽지 못했어요.'));
        reader.readAsDataURL(blob);
    });
}

async function normalizeManualPhoto(file) {
    // 휴대폰 JPEG는 EXIF 방향값에 의존하는 경우가 있다. 브라우저가 방향을
    // 반영한 화소를 새 JPEG로 만든 뒤 서버에서 EXIF를 다시 제거한다.
    if (file.type !== 'image/jpeg' || typeof createImageBitmap !== 'function') {
        return blobToDataUrl(file);
    }
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
        const pixelCount = bitmap.width * bitmap.height;
        if (!bitmap.width
            || !bitmap.height
            || bitmap.width > 8192
            || bitmap.height > 8192
            || pixelCount > 40_000_000) {
            throw new Error('사진 해상도가 너무 커요. 조금 줄인 뒤 다시 올려주세요.');
        }
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('사진 방향을 정리하지 못했어요.');
        context.drawImage(bitmap, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
        if (!blob) throw new Error('사진을 안전하게 변환하지 못했어요.');
        return blobToDataUrl(blob);
    } finally {
        bitmap.close?.();
    }
}

function uploadSheet(room) {
    if ($('.chatlog-upload-sheet').length) return;
    const $sheet = $(`
      <div class="chatlog-sheet chatlog-upload-sheet">
        <div class="chatlog-sheet-inner">
          <div class="chatlog-sheet-title">지금 이 순간</div>
          <input class="chatlog-camera-input" type="file" accept="image/*" capture="environment" hidden>
          <input class="chatlog-gallery-input" type="file" accept="image/*" hidden>
          <div class="chatlog-preview">
            <span class="fa-regular fa-image"></span><small>사진을 선택해주세요</small>
          </div>
          <div class="chatlog-photo-sources">
            <button type="button" class="menu_button chatlog-photo-source camera">
              <span class="fa-solid fa-camera"></span><span>카메라로 찍기</span>
            </button>
            <button type="button" class="menu_button chatlog-photo-source gallery">
              <span class="fa-regular fa-images"></span><span>갤러리에서 선택</span>
            </button>
          </div>
          <textarea class="chatlog-input" rows="2" maxlength="60" placeholder="한 줄만"></textarea>
          <div class="chatlog-sheet-actions">
            <div class="menu_button chatlog-cancel">취소</div>
            <div class="menu_button chatlog-submit">올리기</div>
          </div>
        </div>
      </div>`);

    document.body.appendChild($sheet[0]);

    let imageData = null;
    const readSelectedImage = async function () {
        const f = this.files?.[0];
        if (!f) return;
        if (!f.type.startsWith('image/')) {
            showError('이미지 파일만 선택할 수 있어요.');
            this.value = '';
            return;
        }
        if (f.size > MAX_MANUAL_IMAGE_BYTES) {
            showError('사진은 최대 20MB까지 올릴 수 있어요.');
            this.value = '';
            return;
        }
        try {
            $sheet.find('.chatlog-preview').html('<small>사진의 위치·촬영정보를 정리하는 중...</small>');
            imageData = await normalizeManualPhoto(f);
            $sheet.find('.chatlog-preview').html(`<img src="${escAttr(imageData)}">`);
        } catch (error) {
            imageData = null;
            this.value = '';
            $sheet.find('.chatlog-preview').html(
                '<span class="fa-regular fa-image"></span><small>사진을 선택해주세요</small>',
            );
            showError(error.message || '사진을 읽지 못했어요. 다른 사진으로 다시 시도해 주세요.');
        }
    };
    $sheet.find('.chatlog-camera-input, .chatlog-gallery-input').on('change', readSelectedImage);
    $sheet.find('.chatlog-photo-source.camera').on('click', () => {
        $sheet.find('.chatlog-camera-input').val('').trigger('click');
    });
    $sheet.find('.chatlog-photo-source.gallery').on('click', () => {
        $sheet.find('.chatlog-gallery-input').val('').trigger('click');
    });

    const close = () => $sheet.remove();
    $sheet.on('click', e => { if (e.target === $sheet[0]) close(); });
    $sheet.find('.chatlog-cancel').on('click', close);

    $sheet.find('.chatlog-submit').on('click', async function () {
        const $submit = $(this);
        if ($submit.hasClass('busy')) return;
        const text = $sheet.find('.chatlog-input').val();
        if (!text && !imageData) return close();
        $submit.addClass('busy').text('올리는 중...');
        try {
            let imagePath = null;
            if (imageData) imagePath = await uploadImage(imageData);
            await api('/post', { roomId: room.id, text, image: imagePath });
            close();
            await refresh();
        } catch (e) {
            notify('error', '업로드 실패: ' + e.message);
            $submit.removeClass('busy').text('올리기');
        }
    });
}

async function uploadImage(dataUrl) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('사진 데이터를 읽을 수 없어요.');
    const result = await api('/image/upload', {
        mime: match[1].toLowerCase(),
        image: match[2].replace(/\s+/g, ''),
    });
    if (!result?.path) throw new Error('저장된 사진 경로를 받지 못했어요.');
    return result.path;
}

// ── 하루로그 (같은 시간대는 한 장면에 나란히) ────────────
function groupDayLogPosts(posts) {
    const groups = new Map();
    for (const post of posts) {
        const timestamp = slotTimestamp(post);
        const date = new Date(timestamp);
        const key = `${dayKey(timestamp)}:${date.getHours()}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                hour: date.getHours(),
                timestamp,
                posts: [],
            });
        }
        groups.get(key).posts.push(post);
    }
    return [...groups.values()]
        .map(group => ({
            ...group,
            posts: group.posts.sort((a, b) => a.createdAt - b.createdAt),
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
}

function dayLogView(room, selectedDay = dayKey(Date.now())) {
    const posts = (state.posts[room.id] || [])
        .filter(p => dayKey(slotTimestamp(p)) === selectedDay && p.image)
        .sort((a, b) => slotTimestamp(a) - slotTimestamp(b) || a.createdAt - b.createdAt);
    const groups = groupDayLogPosts(posts);

    const $sheet = $(`
      <div class="chatlog-sheet">
        <div class="chatlog-sheet-inner chatlog-daylog">
          <div class="chatlog-sheet-title">하루로그</div>
          <div class="chatlog-daylog-help">같은 시간대 사진은 한 장면에 나란히 저장돼요.</div>
          <div class="chatlog-grid"></div>
          <div class="chatlog-sheet-actions">
            <div class="menu_button chatlog-export">GIF 저장</div>
            <div class="menu_button chatlog-cancel">닫기</div>
          </div>
          <div class="chatlog-progress"></div>
        </div>
      </div>`);
    document.body.appendChild($sheet[0]);

    const $grid = $sheet.find('.chatlog-grid');
    const n = posts.length;

    if (!n) {
        $grid.html('<div class="chatlog-empty">이 날의 사진이 아직 없어요.</div>');
    } else {
        groups.forEach(group => {
            const $group = $(`
              <section class="chatlog-daylog-hour">
                <div class="chatlog-daylog-hour-label">${String(group.hour).padStart(2, '0')}:00</div>
                <div class="chatlog-daylog-photos"></div>
              </section>`);
            const $photos = $group.find('.chatlog-daylog-photos');
            const count = group.posts.length;
            $photos.css('--chatlog-daylog-columns', count === 1 ? 1 : Math.min(count, 3));
            group.posts.forEach(p => {
                const author = characterName(room, p.author, p.authorName);
                $photos.append(`
                  <div class="chatlog-cell">
                    <img src="${escAttr(p.image)}">
                    <span class="chatlog-stamp">${esc(author)} · ${hhmm(p.createdAt)}</span>
                  </div>`);
            });
            $grid.append($group);
        });
    }

    const $btn = $sheet.find('.chatlog-export');
    const $prog = $sheet.find('.chatlog-progress');
    $btn.toggleClass('disabled', !n);

    $btn.on('click', async () => {
        if (!n || $btn.hasClass('busy')) return;
        $btn.addClass('busy').text('만드는 중...');
        try {
            await exportDayLogGif(groups, room, selectedDay, (i, total) => {
                $prog.text(`${i} / ${total}`);
            });
            $prog.text('저장 완료');
        } catch (e) {
            $prog.text('실패: ' + e.message);
        } finally {
            $btn.removeClass('busy').text('GIF 저장');
        }
    });

    const close = () => $sheet.remove();
    $sheet.on('click', e => { if (e.target === $sheet[0]) close(); });
    $sheet.find('.chatlog-cancel').on('click', close);
}

// ── 방 만들기 ─────────────────────────────────────────────
async function chooseDisplayPersona(c, members, options = {}) {
    const unique = new Map();
    connectedPersonasForMembers(members).forEach(persona => {
        unique.set(persona.file || persona.name, persona);
    });
    const initial = normalizePersona(options.initialPersona);
    if (initial) unique.set(initial.file || initial.name, initial);
    if (!unique.size) {
        const active = activePersona();
        unique.set(active.file || active.name, active);
    }
    const candidates = [...unique.values()];
    const selectedIndex = Math.max(0, candidates.findIndex(persona =>
        initial
            ? persona.file === initial.file && persona.name === initial.name
            : persona.file === activePersona().file));
    const $picker = $(`
      <div class="chatlog-personapick">
        <div class="chatlog-picktitle">${esc(options.title || '이 단톡에 표시할 페르소나')}</div>
        <div class="chatlog-pickhint">캐릭터별 관계는 각자 연결된 페르소나를 따로 참고해요.</div>
        <div class="chatlog-personagrid"></div>
      </div>`);
    const $grid = $picker.find('.chatlog-personagrid');

    candidates.forEach((persona, index) => {
        const $row = $('<label class="chatlog-personarow"></label>');
        $('<input>', {
            type: 'radio',
            name: 'chatlog-display-persona',
            value: String(index),
            checked: index === selectedIndex,
        }).appendTo($row);
        $('<img>', {
            src: persona.file
                ? `/User Avatars/${encodeURIComponent(persona.file)}`
                : '/img/user-default.png',
            alt: '',
        }).appendTo($row);
        $('<span>').text(persona.name).appendTo($row);
        $grid.append($row);
    });

    const ok = await c.callGenericPopup?.($picker[0], c.POPUP_TYPE?.CONFIRM, '', {
        okButton: options.okButton || '이 페르소나로 만들기',
        cancelButton: '취소',
    });
    if (!ok) return null;
    const index = Number($picker.find('input:checked').val());
    return candidates[index] || candidates[0];
}

async function changeRoomDisplayPersona(room) {
    const persona = await chooseDisplayPersona(ctx(), room.members, {
        initialPersona: room.persona,
        title: '표시 페르소나 변경',
        okButton: '변경',
    });
    if (!persona) return;
    const snapshot = {
        name: persona.name,
        description: persona.description || '',
        avatar: persona.file || null,
    };
    await api('/room/update', { roomId: room.id, persona: snapshot });
    room.persona = snapshot;
    room.relationshipGraph = {
        ...(room.relationshipGraph || {}),
        status: 'stale',
        displayPersona: { name: snapshot.name, avatar: snapshot.avatar },
    };
    notify('success', `${persona.name}(으)로 표시합니다. 관계 설정 버튼에서 이 방의 관계를 다시 확인해 주세요.`);
    render();
}

async function refreshRoomRelationships(room, button = null, options = {}) {
    const $button = button ? $(button) : null;
    if ($button?.hasClass('busy')) return null;
    $button?.addClass('busy');
    if (!options.silent) notify('info', '캐릭터 카드와 최근 채팅에서 단톡 관계를 분석하고 있어요.');
    try {
        const result = await api('/room/relationships/refresh', { roomId: room.id });
        if (result.room) {
            state.rooms[room.id] = result.room;
            room = result.room;
        } else if (result.relationshipGraph) {
            room.relationshipGraph = result.relationshipGraph;
        }
        const summary = room.relationshipGraph?.summary
            ? ` ${room.relationshipGraph.summary.slice(0, 180)}`
            : '';
        notify('success', `단톡 관계를 저장했어요.${summary}`);
        render();
        return room.relationshipGraph;
    } catch (error) {
        room.relationshipGraph = {
            ...(room.relationshipGraph || {}),
            status: 'error',
            lastError: error.message,
        };
        notify('error', error.message);
        render();
        return null;
    } finally {
        $button?.removeClass('busy');
    }
}

const RELATION_OPTIONS = [
    ['unknown', '미설정'],
    ['custom', '직접 입력'],
    ['spouse', '배우자'],
    ['romantic', '연인'],
    ['family', '가족'],
    ['close_friend', '절친'],
    ['friend', '친구'],
    ['colleague', '동료'],
    ['rival', '라이벌'],
    ['acquaintance', '지인'],
    ['ex', '전 연인'],
    ['hostile', '적대 관계'],
];

async function editRoomRelationships(room, options = {}) {
    if ($('.chatlog-relation-sheet').length) return;
    const actor = personaForRoom(room);
    const saved = new Map(
        (room.relationshipGraph?.memberRelations || [])
            .map(relation => [relation.memberAvatar, relation]),
    );
    const $sheet = $(`
      <div class="chatlog-sheet chatlog-relation-sheet">
        <div class="chatlog-sheet-inner chatlog-relation-editor">
          <div class="chatlog-sheet-title">관계 직접 설정</div>
          <div class="chatlog-relation-help">
            화면의 <b>${esc(actor.name)}</b>와 각 캐릭터의 관계를 방 전용으로 고정해요.
            저장한 관계는 AI 분석보다 우선하며 다른 페르소나의 관계가 섞이지 않아요.
          </div>
          <div class="chatlog-relation-list"></div>
          <div class="chatlog-relation-footer">
            <button type="button" class="menu_button chatlog-relation-ai">AI 제안으로 채우기</button>
            <button type="button" class="menu_button chatlog-cancel">나중에</button>
            <button type="button" class="menu_button chatlog-relation-save">관계 저장</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild($sheet[0]);
    const $list = $sheet.find('.chatlog-relation-list');

    for (const member of room.members || []) {
        const relation = saved.get(member.avatar) || {};
        const $row = $(`
          <section class="chatlog-relation-row" data-avatar="${escAttr(member.avatar)}">
            <div class="chatlog-relation-person">
              <img src="${escAttr(avatarUrl(member.avatar))}" alt="">
              <div><b>${esc(member.name)}</b><small>${esc(actor.name)}와의 관계</small></div>
            </div>
            <label>관계
              <select class="chatlog-relation-type">
                ${RELATION_OPTIONS.map(([value, label]) =>
                    `<option value="${value}"${value === (relation.type || 'unknown') ? ' selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
            <label class="chatlog-custom-relation"${relation.type === 'custom' ? '' : ' style="display:none"'}>
              직접 입력한 관계
              <input class="chatlog-relation-label" maxlength="80"
                placeholder="예: 보호자와 피보호자, 소꿉친구, 의형제"
                value="${escAttr(relation.type === 'custom' ? relation.label || '' : '')}">
            </label>
            <label>${esc(member.name)} → ${esc(actor.name)} 호칭
              <input class="chatlog-member-call" maxlength="80" placeholder="예: 이름, 선배, 자기" value="${escAttr(relation.memberCallsPersona || '')}">
            </label>
            <label>${esc(actor.name)} → ${esc(member.name)} 호칭
              <input class="chatlog-persona-call" maxlength="80" placeholder="예: 이름, 오빠, 여보" value="${escAttr(relation.personaCallsMember || '')}">
            </label>
            <label>금지 호칭·관계 표현
              <input class="chatlog-forbidden" maxlength="160" placeholder="예: 꼬맹이, 여친, 자기" value="${escAttr(relation.forbiddenTerms || '')}">
            </label>
            <label>관계 메모
              <textarea class="chatlog-relation-note" rows="2" maxlength="300" placeholder="다른 멤버들도 알고 있어야 할 사실만">${esc(relation.note || '')}</textarea>
            </label>
          </section>`);
        $row.find('.chatlog-relation-type').on('change', function () {
            const custom = this.value === 'custom';
            $row.find('.chatlog-custom-relation').toggle(custom);
            if (custom) $row.find('.chatlog-relation-label').trigger('focus');
        });
        $list.append($row);
    }

    const close = () => $sheet.remove();
    $sheet.on('click', event => { if (event.target === $sheet[0]) close(); });
    $sheet.find('.chatlog-cancel').on('click', close);
    $sheet.find('.chatlog-relation-ai').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('busy')) return;
        $button.addClass('busy').text('분석 중...');
        const graph = await refreshRoomRelationships(room, null, { silent: false });
        $button.removeClass('busy').text('AI 제안으로 채우기');
        if (!graph) return;
        close();
        const freshRoom = state.rooms[room.id] || room;
        editRoomRelationships(freshRoom, options);
    });
    $sheet.find('.chatlog-relation-save').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('busy')) return;
        $button.addClass('busy').text('저장 중...');
        let invalidCustom = null;
        const memberRelations = $sheet.find('.chatlog-relation-row').map((_, element) => {
            const $row = $(element);
            const member = room.members.find(item => item.avatar === $row.data('avatar'));
            const type = $row.find('.chatlog-relation-type').val();
            const customLabel = $row.find('.chatlog-relation-label').val().trim();
            if (type === 'custom' && !customLabel && !invalidCustom) invalidCustom = $row;
            return {
                memberAvatar: $row.data('avatar'),
                memberName: member?.name || $row.data('avatar'),
                type,
                label: type === 'custom' ? customLabel : '',
                memberCallsPersona: $row.find('.chatlog-member-call').val().trim(),
                personaCallsMember: $row.find('.chatlog-persona-call').val().trim(),
                forbiddenTerms: $row.find('.chatlog-forbidden').val().trim(),
                note: $row.find('.chatlog-relation-note').val().trim(),
            };
        }).get();
        if (invalidCustom) {
            notify('warning', '직접 입력한 관계 이름을 적어 주세요.');
            invalidCustom.find('.chatlog-relation-label').trigger('focus');
            $button.removeClass('busy').text('관계 저장');
            return;
        }
        try {
            const result = await api('/room/relationships/manual', {
                roomId: room.id,
                memberRelations,
            });
            state.rooms[room.id] = result.room;
            close();
            notify('success', '이 방의 관계를 직접 고정했어요.');
            render();
        } catch (error) {
            notify('error', '관계 저장 실패: ' + error.message);
            $button.removeClass('busy').text('관계 저장');
        }
    });
}

async function createRoomFlow() {
    const c = ctx();
    const chars = c.characters || [];
    const name = await c.callGenericPopup?.('로그 이름', c.POPUP_TYPE?.INPUT, '우리 로그');
    if (!name) return;

    const $picker = $(`
      <div class="chatlog-charpick-wrap">
        <input class="chatlog-char-search" type="search" placeholder="캐릭터 이름 검색">
        <div class="chatlog-charpick"></div>
      </div>`);
    const $list = $picker.find('.chatlog-charpick');
    chars.forEach(ch => {
        const $row = $(`
          <label class="chatlog-charrow" data-search="${escAttr(String(ch.name || '').toLowerCase())}">
            <input type="checkbox" value="${escAttr(ch.avatar)}">
            <img src="${escAttr(avatarUrl(ch.avatar))}"><span>${esc(ch.name)}</span>
          </label>`);
        $list.append($row);
    });
    $picker.find('.chatlog-char-search').on('input', function () {
        const query = String(this.value || '').trim().toLowerCase();
        $list.find('.chatlog-charrow').each((_, element) => {
            const $row = $(element);
            $row.toggle(!query || String($row.data('search') || '').includes(query));
        });
    });

    const ok = await c.callGenericPopup?.($picker[0], c.POPUP_TYPE?.CONFIRM, '', { okButton: '다음' });
    if (!ok) return;

    const picked = $list.find('input:checked').map((_, el) => el.value).get();
    if (!picked.length) {
        showError('캐릭터를 한 명 이상 선택해 주세요.');
        return;
    }
    const members = fitRoomMemberSnapshots(picked.map(av => {
        const ch = chars.find(x => x.avatar === av) || {};
        return characterSnapshot(ch, av);
    }));
    const truncatedMembers = members
        .filter(member => member.__chatlogTruncated)
        .map(member => member.name || cleanDisplayName(member.avatar));
    if (truncatedMembers.length) {
        notify(
            'warning',
            `${truncatedMembers.join(', ')} 카드가 매우 길어 챗로그용 사본은 캐릭터당 앞부분 240KB까지만 사용합니다.`,
        );
    }

    const persona = await chooseDisplayPersona(c, members);
    if (!persona) return;
    const memberPersonas = memberPersonasForMembers(members);
    for (const [memberAvatar, linkedPersona] of Object.entries(memberPersonas)) {
        if (!linkedPersona?.__chatlogTruncated) continue;
        const memberName = members.find(member => member.avatar === memberAvatar)?.name
            || cleanDisplayName(memberAvatar);
        notify(
            'warning',
            `${memberName}의 연결 페르소나 설명이 매우 길어 챗로그용 사본은 앞부분 240KB까지만 사용합니다.`,
        );
    }
    const personaSnapshot = personaSnapshotForSync(persona);
    if (personaSnapshot.__chatlogTruncated) {
        notify(
            'warning',
            `${personaSnapshot.name} 페르소나 설명이 매우 길어 챗로그용 사본은 앞부분 240KB까지만 사용합니다.`,
        );
    }
    const room = await api('/room', {
        name,
        members,
        schedule: defaultSchedule,
        persona: personaSnapshot,
        memberPersonas,
    });
    state.rooms[room.id] = room;
    await refresh();
    notify('success', '단톡을 만들었어요. 표시 페르소나와의 관계를 정해 주세요.');
    await editRoomRelationships(state.rooms[room.id] || room, { initial: true });
}

async function markRead(roomId) {
    for (const post of state.posts?.[roomId] || []) {
        post.read = true;
        for (const comment of post.comments || []) comment.read = true;
    }
    updateQuickOpenBadge();
    try {
        await api('/read', { roomId });
    } catch {
        refreshQuickBadge();
    }
}



// ═══════════ 백그라운드 생성 (UI 안 뜸) ═══════════
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * ConnectionManagerRequestService — 확장이 연결 프로필로 요청을 보내되
 * 활성 프로필도, 채팅 UI도 건드리지 않는 ST 내장 서비스.
 * 이걸 쓰면 프로필 전환 자체가 필요 없고 생성 UI도 안 뜬다.
 */
let _cmrs = null;
async function getRequestService() {
    if (_cmrs) return _cmrs;
    const c = ctx();
    if (c.ConnectionManagerRequestService) return (_cmrs = c.ConnectionManagerRequestService);
    try {
        const mod = await import('/scripts/extensions/shared.js');
        if (mod?.ConnectionManagerRequestService) return (_cmrs = mod.ConnectionManagerRequestService);
    } catch (e) {
        console.warn('[chatlog] shared.js 로드 실패', e);
    }
    return null;
}

function profileByName(name) {
    return getProfiles().find(p => p.name === name) || null;
}

/** 조용히 한 번 생성. 실패하면 null. */
async function quietGenerate(messages, maxTokens = 1024) {
    const svc = await getRequestService();
    const profileName = $('#chatlog-profile').val() || (await api('/settings')).profileName;
    const profile = profileByName(profileName);

    if (!svc || !profile) {
        console.warn('[chatlog] 백그라운드 생성 불가 — 서버 생성으로 넘기세요');
        return null;
    }

    const res = await svc.sendRequest(profile.id, messages, maxTokens);
    if (typeof res === 'string') return res;
    return res?.content ?? res?.text ?? '';
}

const COMMENT_RULES = [
    '- 댓글은 1~2문장, 40자 내외. 짧을수록 좋다.',
    '- SNS 댓글 말투. 완결된 문장이 아니어도 된다.',
    '- 사진이 있으면 구체적인 것 하나를 집어서 반응하라.',
    '- 나레이션, 행동 묘사(*...*), 따옴표, 이름표 금지. 댓글 텍스트만 출력한다.',
    '- "유저", "user", "페르소나", "persona"는 내부 역할표시다. 상대를 이 단어로 부르지 말고 실제 이름이나 관계에 맞는 호칭을 사용한다.',
].join('\n');

function buildCommentMessages(job) {
    const m = job.member || {};
    const p = job.post || {};
    const room = state.rooms[job.roomId];
    const actorPersona = room ? personaForRoom(room) : null;
    const userName = actorPersona?.name || '유저';
    const isOwnPost = p.author === m.avatar;
    const authorName = p.author === 'user' ? userName : characterName(room, p.author, p.authorName);
    const targetUserComment = job.replyToCommentId
        ? (p.comments || []).find(c => c.id === job.replyToCommentId && c.author === 'user')
        : [...(p.comments || [])].reverse().find(c => c.author === 'user');
    const isReply = isOwnPost && !!targetUserComment;
    const existingComments = (p.comments || [])
        .filter(comment => comment.author !== m.avatar && comment.text)
        .map(comment => `${comment.authorName || comment.author}: ${comment.text}`)
        .slice(-8);
    const recentComments = (job.recentComments || [])
        .map(comment => String(comment || '').trim())
        .filter(Boolean)
        .slice(0, 12);

    const system = [
        `너는 "${m.name}"이다.`,
        m.description ? `설명: ${m.description}` : '',
        m.personality ? `성격: ${m.personality}` : '',
        m.mesExample ? `말투 예시:\n${m.mesExample}` : '',
        room ? relationshipContextForRoom(room) : '',
        actorPersona?.description
            ? `현재 단톡에서 실제로 행동한 표시 페르소나: ${userName}\n${actorPersona.description}`
            : '',
        '',
        isReply
            ? `네가 "${job.roomName}" 로그에 올린 게시물에 ${userName}가 댓글을 달았다. [반드시 답할 댓글]에 직접 답댓글을 단다.`
            : `${authorName}가 "${job.roomName}" 로그에 올린 게시물에 댓글을 단다.`,
        COMMENT_RULES,
        existingComments.length
            ? `이미 이 게시물에 달린 댓글이다. 같은 문장 구조·핵심 소재·명령 방식을 재사용하지 마라:\n${existingComments.join('\n')}`
            : '',
        recentComments.length
            ? `이 방의 최근 댓글이다. 단어만 바꿔 재작성하지 말고 완전히 다른 관점을 고르라:\n${recentComments.join('\n')}`
            : '',
        isReply ? '- 유저 댓글과 무관한 새 화제나 사진 속 인물·옷의 소유자·사건을 추측하지 마라.' : '',
    ].filter(Boolean).join('\n');

    const user = [
        isReply ? `[반드시 답할 댓글]\n${userName}: ${targetUserComment.text}` : '',
        isReply ? '아래 게시물은 답변에 필요한 경우에만 참고한다.' : '',
        `[${timeLabel(p.createdAt)} 게시물]`,
        p.text ? `글: ${p.text}` : '(글 없음)',
        p.image ? '(사진 첨부됨)' : '',
        '',
        isReply ? '위 유저 댓글에 달 답댓글 하나만 출력하라.' : '댓글 하나만 출력하라.',
    ].filter(Boolean).join('\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function cleanComment(raw) {
    return (raw || '')
        .trim()
        .replace(/^["'\u300c\u300e]|["'\u300d\u300f]$/g, '')
        .replace(/^\*+|\*+$/g, '')
        .replace(/^[^:\n]{1,20}:\s*/, '')
        .split('\n')[0]
        .slice(0, 120)
        .trim();
}

/** 브라우저에서 대기 댓글 처리 — 채팅 UI에 아무것도 안 뜬다 */
async function runLocal(roomId = null) {
    const svc = await getRequestService();
    if (!svc) {
        notify('warning', '백그라운드 생성 API를 못 찾았어요. /chatlog-run 으로 서버에서 돌리세요');
        return 0;
    }

    const jobs = await api('/jobs/claim', { roomId, type: 'comment' });
    if (!jobs.length) { notify('info', '대기 중인 댓글이 없어요'); return 0; }

    let ok = 0;
    for (const job of jobs) {
        try {
            const raw = await quietGenerate(buildCommentMessages(job));
            if (raw == null) throw new Error('생성 실패');
            await api('/comment/push', {
                roomId: job.roomId,
                postId: job.postId,
                charId: job.charId,
                charName: job.member?.name,
                text: cleanComment(raw),
            });
            ok++;
        } catch (e) {
            console.error('[chatlog] 댓글 생성 실패', job.charId, e);
            try {
                await api('/jobs/requeue', { job, error: e.message });
            } catch (requeueError) {
                console.error('[chatlog] 댓글 재시도 예약 실패', requeueError);
            }
        }
        await delay(400);   // 연타 방지
    }

    notify('success', `댓글 ${ok}개 생성`);
    if ($overlay) refresh();
    return ok;
}

// ═══════════ 저장 / 내보내기 ═══════════
async function downloadUrl(url, filename) {
    const blob = await (await fetch(url)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function loadImg(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function dayLogFrameRects(count, width, height) {
    if (count <= 1) return [{ x: 0, y: 0, width, height }];
    const gap = 4;
    const columns = count === 4 ? 2 : Math.min(count, 3);
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    return Array.from({ length: count }, (_, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = Math.round(column * (cellWidth + gap));
        const y = Math.round(row * (cellHeight + gap));
        const nextX = column === columns - 1 ? width : Math.round((column + 1) * (cellWidth + gap) - gap);
        const nextY = row === rows - 1 ? height : Math.round((row + 1) * (cellHeight + gap) - gap);
        return { x, y, width: nextX - x, height: nextY - y };
    });
}

function drawImageCover(g, image, rect) {
    const scale = Math.max(rect.width / image.width, rect.height / image.height);
    const sourceWidth = rect.width / scale;
    const sourceHeight = rect.height / scale;
    const sourceX = (image.width - sourceWidth) / 2;
    const sourceY = (image.height - sourceHeight) / 2;
    g.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight,
        rect.x, rect.y, rect.width, rect.height);
}

function gifPalette332() {
    const palette = new Uint8Array(256 * 3);
    for (let index = 0; index < 256; index++) {
        palette[index * 3] = Math.round(((index >> 5) & 7) * 255 / 7);
        palette[index * 3 + 1] = Math.round(((index >> 2) & 7) * 255 / 7);
        palette[index * 3 + 2] = (index & 3) * 85;
    }
    return palette;
}

function quantizeGifFrame(imageData) {
    const rgba = imageData.data;
    const indexed = new Uint8Array(rgba.length / 4);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target++) {
        indexed[target] = (rgba[source] & 0xe0)
            | ((rgba[source + 1] & 0xe0) >> 3)
            | (rgba[source + 2] >> 6);
    }
    return indexed;
}

function gifLzwEncode(indexedPixels) {
    const clearCode = 256;
    const endCode = 257;
    let nextCode = 258;
    let codeSize = 9;
    let bitBuffer = 0;
    let bitCount = 0;
    const bytes = [];
    const dictionary = new Map();

    const writeCode = code => {
        bitBuffer |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
            bytes.push(bitBuffer & 0xff);
            bitBuffer >>>= 8;
            bitCount -= 8;
        }
    };
    const reset = () => {
        dictionary.clear();
        nextCode = 258;
        codeSize = 9;
    };

    writeCode(clearCode);
    if (!indexedPixels.length) {
        writeCode(endCode);
    } else {
        let prefix = indexedPixels[0];
        for (let index = 1; index < indexedPixels.length; index++) {
            const suffix = indexedPixels[index];
            const key = prefix * 256 + suffix;
            const found = dictionary.get(key);
            if (found !== undefined) {
                prefix = found;
                continue;
            }

            writeCode(prefix);
            if (nextCode < 4096) {
                dictionary.set(key, nextCode++);
                // 디코더는 첫 데이터 코드를 읽은 뒤부터 사전을 추가하므로
                // 인코더보다 한 항목 늦다. 경계를 한 코드 지나서 비트 수를 올린다.
                if (nextCode === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
            } else {
                writeCode(clearCode);
                reset();
            }
            prefix = suffix;
        }
        writeCode(prefix);
        writeCode(endCode);
    }
    if (bitCount > 0) bytes.push(bitBuffer & 0xff);
    return new Uint8Array(bytes);
}

function gifDataBlocks(data) {
    const chunks = [new Uint8Array([8])];
    for (let offset = 0; offset < data.length; offset += 255) {
        const size = Math.min(255, data.length - offset);
        chunks.push(new Uint8Array([size]), data.slice(offset, offset + size));
    }
    chunks.push(new Uint8Array([0]));
    return chunks;
}

function encodeAnimatedGif(frames, width, height, delayCentiseconds = 140) {
    const ascii = text => new Uint8Array([...text].map(char => char.charCodeAt(0)));
    const le16 = value => [value & 0xff, (value >> 8) & 0xff];
    const chunks = [
        ascii('GIF89a'),
        new Uint8Array([...le16(width), ...le16(height), 0xf7, 0, 0]),
        gifPalette332(),
        new Uint8Array([
            0x21, 0xff, 0x0b,
            ...[...'NETSCAPE2.0'].map(char => char.charCodeAt(0)),
            0x03, 0x01, 0x00, 0x00, 0x00,
        ]),
    ];

    for (const frame of frames) {
        const compressed = gifLzwEncode(frame);
        chunks.push(
            new Uint8Array([
                0x21, 0xf9, 0x04, 0x00,
                ...le16(delayCentiseconds), 0x00, 0x00,
            ]),
            new Uint8Array([
                0x2c, 0x00, 0x00, 0x00, 0x00,
                ...le16(width), ...le16(height), 0x00,
            ]),
            ...gifDataBlocks(compressed),
        );
    }
    chunks.push(new Uint8Array([0x3b]));

    const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

/** 시간대마다 한 프레임, 같은 시간대 사진은 한 프레임 안에 나란히 배치한 실제 GIF */
async function exportDayLogGif(groups, room, selectedDay, onProgress) {
    const width = 640;
    const visibleCard = $overlay?.find('.chatlog-scard').get(0);
    const visibleRect = visibleCard?.getBoundingClientRect?.();
    const visibleRatio = visibleRect?.width > 0 && visibleRect?.height > 0
        ? visibleRect.width / visibleRect.height
        : 16 / 10;
    const height = Math.max(320, Math.round(width / visibleRatio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('이미지 캔버스를 만들 수 없어요.');

    const frames = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        onProgress?.(groupIndex + 1, groups.length);
        const loaded = (await Promise.all(group.posts.map(async post => {
            try {
                return { post, image: await loadImg(post.image) };
            } catch {
                return null;
            }
        }))).filter(Boolean);
        if (!loaded.length) continue;

        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, width, height);
        const rects = dayLogFrameRects(loaded.length, width, height);
        loaded.forEach(({ post, image }, index) => {
            const rect = rects[index];
            drawImageCover(g, image, rect);

            const author = characterName(room, post.author, post.authorName);
            const label = `${author} · ${hhmm(post.createdAt)}`;
            g.font = '700 17px -apple-system, "Noto Sans KR", sans-serif';
            g.textBaseline = 'middle';
            const labelWidth = Math.min(rect.width - 16, g.measureText(label).width + 20);
            g.fillStyle = 'rgba(0,0,0,0.58)';
            g.fillRect(rect.x + 8, rect.y + 8, Math.max(0, labelWidth), 32);
            g.fillStyle = '#ffffff';
            g.save();
            g.beginPath();
            g.rect(rect.x + 8, rect.y + 8, Math.max(0, labelWidth), 32);
            g.clip();
            g.fillText(label, rect.x + 18, rect.y + 24);
            g.restore();

            if (post.text) {
                const caption = String(post.text).slice(0, 28);
                g.fillStyle = 'rgba(0,0,0,0.58)';
                g.fillRect(rect.x, rect.y + rect.height - 52, rect.width, 52);
                g.fillStyle = '#ffffff';
                g.font = '600 18px -apple-system, "Noto Sans KR", sans-serif';
                g.save();
                g.beginPath();
                g.rect(rect.x + 12, rect.y + rect.height - 52, rect.width - 24, 52);
                g.clip();
                g.fillText(caption, rect.x + 14, rect.y + rect.height - 25);
                g.restore();
            }
        });

        frames.push(quantizeGifFrame(g.getImageData(0, 0, width, height)));
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!frames.length) throw new Error('GIF로 만들 수 있는 사진이 없어요.');

    onProgress?.(frames.length, frames.length);
    const bytes = encodeAnimatedGif(frames, width, height);
    const blob = new Blob([bytes], { type: 'image/gif' });
    const safeRoomName = String(room.name || 'chatlog').replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `daylog_${safeRoomName}_${selectedDay}.gif`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// ── 슬래시 커맨드 ─────────────────────────────────────────
function registerSlashCommands() {
    const c = ctx();
    const P = c.SlashCommandParser;
    const Cmd = c.SlashCommand;
    const Arg = c.SlashCommandNamedArgument;
    if (!P || !Cmd) { console.warn('[chatlog] 슬래시 커맨드 API 없음'); return; }

    const roomIdByName = (name) => {
        if (!name) return null;
        const room = Object.values(state.rooms).find(r => r.name === name);
        return room?.id || null;
    };

    const ensureState = async () => { state = await api('/state'); };

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog',
        helpString: '챗로그 열기',
        callback: async () => { openChatlog(); return ''; },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-run',
        helpString: '강제 실행. what=comments|reactions|cut|all (기본 all), room=로그 이름',
        namedArgumentList: [
            Arg?.fromProps?.({ name: 'what', description: 'comments | reactions | cut | all', defaultValue: 'all', isRequired: false }),
            Arg?.fromProps?.({ name: 'room', description: '로그 이름 (생략 시 전체)', isRequired: false }),
        ].filter(Boolean),
        callback: async (args) => {
            await ensureState();
            const r = await api('/force', { what: args.what || 'all', roomId: roomIdByName(args.room) });
            const msg = `댓글 ${r.comments}개, 반응 ${r.reactions || 0}개, 컷 ${r.cuts}개 생성`
                + (r.skipped ? `, ${r.skipped}개 건너뜀` : '')
                + (r.errors?.length ? ` / 오류 ${r.errors.length}건` : '');
            notify('info', msg);
            if (r.errors?.length) console.warn('[chatlog]', r.errors);
            if ($overlay) refresh();
            return msg;
        },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-now',
        helpString: '다음 슬롯을 지금으로 당김 (다음 틱에 생성)',
        namedArgumentList: [Arg?.fromProps?.({ name: 'room', description: '로그 이름', isRequired: false })].filter(Boolean),
        callback: async (args) => {
            await ensureState();
            await api('/force/now', { roomId: roomIdByName(args.room) });
            notify('info', '다음 슬롯을 지금으로 당겼어요 (1분 내 실행)');
            return 'ok';
        },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-local',
        helpString: '대기 댓글을 브라우저에서 조용히 생성 (채팅 UI에 안 뜸)',
        namedArgumentList: [Arg?.fromProps?.({ name: 'room', description: '로그 이름', isRequired: false })].filter(Boolean),
        callback: async (args) => {
            await ensureState();
            const n = await runLocal(roomIdByName(args.room));
            return String(n);
        },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-reload',
        helpString: '서버의 ai.js / settings.json 다시 읽기 (ST 재시작 불필요)',
        callback: async () => {
            const r = await api('/reload', {});
            notify('success', '리로드 완료');
            return JSON.stringify(r);
        },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-jobs',
        helpString: '대기 중인 작업 목록',
        callback: async () => {
            const jobs = await api('/jobs');
            console.table(jobs);
            notify('info', `대기 중 ${jobs.length}건 (콘솔 확인)`);
            return JSON.stringify(jobs);
        },
    }));
}


// ═══════════ 콘솔 디버그 헬퍼 (window.cl) ═══════════
// 브라우저 콘솔에서 바로 사용: cl.rooms(), cl.run('cut'), cl.posts() ...
window.cl = {
    _call: api,
    rooms: async () => Object.values((await api('/state')).rooms)
        .map(r => ({ id: r.id, name: r.name, 멤버: r.members.map(m => m.name).join(','),
                     다음: new Date(r.nextSlotAt).toLocaleString('ko-KR') })),
    run: (what = 'all', roomId = null) => api('/force', { what, roomId }),
    now: () => api('/force/now', {}),
    posts: async (roomId) => {
        const s = await api('/state');
        const id = roomId || Object.keys(s.rooms)[0];
        return (s.posts[id] || []).map(p => ({ 작성자: p.authorName || p.author, 글: p.text,
            사진: p.image, 댓글: p.comments.map(c => `${c.authorName}: ${c.text}`) }));
    },
    settings: () => api('/settings'),
    set: (o) => api('/settings', o),
    img: (prompt) => api('/test/image', prompt ? { prompt } : {}),
    reload: () => api('/reload', {}),
    jobs: () => api('/jobs'),
    cleanup: () => api('/cleanup', { force: true }),
    debug: () => api('/debug'),
    version: CHATLOG_VERSION,
    help: () => console.table({
        'cl.rooms()': '방 목록 + 다음 슬롯',
        "cl.run('cut'|'comments'|'all')": '지금 강제 생성',
        'cl.now()': '다음 슬롯을 지금으로 (1분 내 실행)',
        'cl.posts()': '게시물/댓글 확인',
        'cl.settings() / cl.set({...})': '설정 확인/변경',
        "cl.img('prompt?')": '이미지 생성 테스트',
        'cl.reload()': 'ai.js 핫 리로드',
        'cl.jobs()': '대기 작업',
        'cl.cleanup()': '지난 기록 즉시 정리',
        'cl.debug()': '최근 AI 응답 원문 10건 (파싱 문제 확인용)',
    }),
};

// ── 진입 ──────────────────────────────────────────────────
jQuery(async () => {
    $('#extensions_settings2').append(SETTINGS_HTML);
    const $settingsDrawer = $('.chatlog-settings .inline-drawer-content');
    $settingsDrawer.hide();
    $('.chatlog-settings .inline-drawer-icon').addClass('down');
    $('#chatlog-save').on('click', saveSettingsUi);
    $('#chatlog-open').on('click', openChatlog);
    $('#chatlog-profile-refresh').on('click', () => {
        const n = refreshProfileSelect().length;
        refreshImageProfileSelect();
        notify('info', n ? `연결 프로필 ${n}개` : '연결 프로필을 못 찾았어요');
    });
    $('#chatlog-image-profile-refresh').on('click', () => {
        const n = refreshImageProfileSelect().length;
        notify('info', n ? `연결 프로필 ${n}개` : '연결 프로필을 못 찾았어요');
    });
    $('#chatlog-textmode').on('change', toggleTextMode);
    $('#chatlog-image-profile').on('change', updateImageProfileInfo);
    $('#chatlog-image-model').on('change', function () {
        const custom = this.value === '__custom';
        $('.chatlog-custom-model-field').toggle(custom);
        if (custom) $('#chatlog-image-model-custom').trigger('focus');
    });
    $('#chatlog-test-image').on('click', async () => {
        const $r = $('#chatlog-test-result').text('생성 중...');
        try {
            await api('/settings', {
                imageProfileName: $('#chatlog-image-profile').val(),
                imageModel: readImageModel(),
            });
            const r = await api('/test/image', {});
            const $link = $('<a>', {
                href: String(r.path || ''),
                target: '_blank',
                rel: 'noopener noreferrer',
                text: '이미지 보기',
            });
            $r.empty().append(document.createTextNode('성공 — '), $link);
        } catch (e) {
            $r.text('실패: ' + e.message);
        }
    });
    $('#chatlog-reload').on('click', async () => {
        try { await api('/reload', {}); notify('success', '서버 코드 리로드 완료'); }
        catch (e) { notify('error', '리로드 실패: ' + e.message); }
    });
    $('#chatlog-status-refresh').on('click', loadRuntimeStatus);
    $('#chatlog-cleannow').on('click', async () => {
        if (!confirm('지난 기록을 지금 정리할까요?')) return;
        await api('/cleanup', { force: true });
        notify('success', '정리 완료');
        if ($overlay) refresh();
    });
    // 확장 설정 드로어를 열 때마다 프로필 목록과 현재 선택값 갱신
    $(document).on('click', '.chatlog-settings .inline-drawer-toggle', () => setTimeout(() => {
        if ($('#chatlog-follow-profile').is(':checked')) syncActiveConnectionProfile();
        else refreshProfileSelect();
        refreshImageProfileSelect();
        loadRuntimeStatus();
    }, 50));
    $('#chatlog-follow-profile').on('change', function () {
        $('#chatlog-profile').prop('disabled', this.checked);
        if (this.checked) syncActiveConnectionProfile();
    });
    $('#chatlog-selfie-photo-chance').on('input change', function () {
        const selfie = Math.max(0, Math.min(100, Number(this.value) || 0));
        this.value = selfie;
        $('#chatlog-everyday-photo-chance').val(100 - selfie);
    });
    $('#chatlog-everyday-photo-chance').on('input change', function () {
        const everyday = Math.max(0, Math.min(100, Number(this.value) || 0));
        this.value = everyday;
        $('#chatlog-selfie-photo-chance').val(100 - everyday);
    });
    $(document).on('input', '#chatlog-active-from, #chatlog-active-to, #chatlog-interval', updateCostHint);
    ensureQuickOpenButton();
    await Promise.all([loadSettingsUi(), refreshQuickBadge()]);

    // 연결 프로필 목록은 ST가 늦게 채우는 경우가 있어 몇 번 더 확인한다
    const c0 = ctx();
    if (c0.eventSource && c0.eventTypes?.APP_READY) {
        c0.eventSource.on(c0.eventTypes.APP_READY, () => {
            refreshProfileSelect();
            refreshImageProfileSelect();
            ensureQuickOpenButton();
            refreshQuickBadge();
        });
    }
    if (c0.eventSource && c0.eventTypes?.SETTINGS_UPDATED) {
    }
    if (c0.eventSource && c0.eventTypes?.CONNECTION_PROFILE_LOADED) {
        c0.eventSource.on(c0.eventTypes.CONNECTION_PROFILE_LOADED, name => syncActiveConnectionProfile(name));
    }
    $('#chatlog-profile').prop('disabled', $('#chatlog-follow-profile').is(':checked'));
    [500, 1500, 4000].forEach(ms => setTimeout(() => {
        if (!getProfiles().length) return;
        if ($('#chatlog-follow-profile').is(':checked')) syncActiveConnectionProfile();
        else refreshProfileSelect();
        refreshImageProfileSelect();
    }, ms));
    setInterval(ensureQuickOpenButton, 5000);
    setInterval(refreshQuickBadge, 30000);

    registerSlashCommands();
    console.log(`[chatlog] v${CHATLOG_VERSION} 로드됨 — cl.help() 로 디버그 명령 확인`);
});
