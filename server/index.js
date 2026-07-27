/**
 * 챗로그 ST 서버 플러그인
 * 배치: SillyTavern/plugins/chatlog/index.js
 */

const fs = require('fs');
const path = require('path');
const { findSillyTavernRoot } = require('./paths');
const { stripImagePrivacyMetadata } = require('./image-security');

// ai.js 는 핫 리로드 대상 — 캐시를 비우면 서버 재시작 없이 새 코드가 먹는다
let _ai = require('./ai');
function reloadAi() {
    delete require.cache[require.resolve('./ai')];
    _ai = require('./ai');
    return true;
}
const ai = new Proxy({}, { get: (_, k) => _ai[k] });

const DATA_PATH = path.join(__dirname, 'data.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const TICK_MS = 60 * 1000;
const MISSED_SLOT_GRACE_MS = 30 * 60 * 1000;
const RETRY_DELAYS_MS = [10, 30, 60].map(minutes => minutes * 60 * 1000);
const TEST_IMAGE_COOLDOWN_MS = 30 * 1000;
const FORCE_COOLDOWN_MS = 30 * 1000;
const RELOAD_COOLDOWN_MS = 5 * 1000;
const CLEANUP_COOLDOWN_MS = 10 * 1000;
const RELATIONSHIP_COOLDOWN_MS = 30 * 1000;

// 심볼릭 링크 설치에서도 실제 server.js가 있는 ST 루트를 찾는다.
const ST_ROOT = findSillyTavernRoot();

// ── 저장소 ────────────────────────────────────────────────
let db = {
    rooms: {},
    posts: {},
    jobs: [],
    runtime: {
        lastTickAt: null,
        lastSuccessAt: null,
        lastSuccess: '',
        lastErrorAt: null,
        lastError: '',
        lastNoticeAt: null,
        lastNotice: '',
        skippedMissedSlots: 0,
    },
};

let settings = {
    profileName: '',        // ST 연결 프로필 이름 (텍스트 생성용)
    imageProfileName: '',   // ST 연결 프로필 이름 (이미지 생성용)
    followActiveProfile: true, // 클라이언트가 ST의 현재 연결 프로필을 자동 동기화
    userHandle: 'default-user',
    imageApiKey: '',        // v0.7.13 이하 설정 호환용 (신규 호출에는 사용하지 않음)
    textMode: 'profile',                         // 텍스트는 ST 연결 프로필만 사용
    imageProvider: 'vertex',                     // 이미지는 Vertex Express만 사용
    imageModel: 'gemini-3.1-flash-lite-image',   // 실제 이미지 요청에 사용할 모델
    imageProjectId: '',                          // v0.7.13 이하 설정 호환용
    imageRegion: 'global',                       // v0.7.13 이하 설정 호환용
    userPersonaName: '',    // 유저 페르소나 이름 (클라이언트가 동기화)
    selfiePhotoChance: 50,  // 전체 사진 중 셀카 기본 비율
    partnerSelfieChance: 45, // 셀카 중 연결 페르소나 동반 비율
    roomMeetupChance: 28,   // 슬롯마다 같은 방 캐릭터 공동 장면을 만들 확률
    sharedScenePostChance: 55, // 공동 장면의 추가 참석자가 자기 시점 게시를 시도할 확률
    commentDelayMinMin: 1,
    commentDelayMaxMin: 30,
    characterCommentChance: 30, // 다른 캐릭터 게시물에 댓글도 남길 확률
    autoCleanup: false,       // 지난 날 이미지/게시물 자동 삭제
    cleanupAfterDays: 1,      // 며칠 지난 것부터 지울지
    keepSaved: true,          // 저장 표시한 건 남기기
    debugEnabled: false,      // 상세 AI 응답은 사용자가 명시적으로 켰을 때만 공개
};

const protectedActions = new Map();
const requestBuckets = new Map();

function acquireProtectedAction(key, cooldownMs) {
    const now = Date.now();
    const previous = protectedActions.get(key);
    if (previous?.running) {
        return { ok: false, reason: 'running', retryAfterMs: Math.max(1000, cooldownMs) };
    }
    if (previous?.nextAllowedAt > now) {
        return {
            ok: false,
            reason: 'cooldown',
            retryAfterMs: previous.nextAllowedAt - now,
        };
    }

    protectedActions.set(key, { running: true, nextAllowedAt: 0 });
    let released = false;
    return {
        ok: true,
        release() {
            if (released) return;
            released = true;
            protectedActions.set(key, {
                running: false,
                nextAllowedAt: Date.now() + cooldownMs,
            });
        },
    };
}

function rejectProtectedAction(res, guard, label) {
    const retryAfterSeconds = Math.max(1, Math.ceil(guard.retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
        error: guard.reason === 'running'
            ? `${label} 작업이 이미 진행 중입니다`
            : `${label} 작업은 ${retryAfterSeconds}초 뒤에 다시 실행할 수 있습니다`,
        retryAfterSeconds,
    });
}

function enforceRequestBudget(req, res, next) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const limit = req.method === 'GET' || req.method === 'HEAD' ? 300 : 180;
    const remote = String(req.socket?.remoteAddress || 'local').slice(0, 80);
    const routePath = String(req.path || req.originalUrl || '').slice(0, 160);
    const key = `${remote}|${req.method}|${routePath}`;
    let bucket = requestBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
        bucket = { startedAt: now, count: 0 };
        requestBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((bucket.startedAt + windowMs - now) / 1000),
        );
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
            error: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
            retryAfterSeconds,
        });
    }
    if (requestBuckets.size > 2000) {
        for (const [bucketKey, value] of requestBuckets) {
            if (now - value.startedAt >= windowMs) requestBuckets.delete(bucketKey);
        }
    }
    next();
}

// 리버스 프록시 뒤에 두는 경우에만 CHATLOG_TRUST_PROXY=1 로 켠다.
// 기본값에서 X-Forwarded-Host를 신뢰하면 공격자가 헤더를 위조해
// 아래 출처 검사를 그대로 통과시킬 수 있다.
const TRUST_FORWARDED_HOST = process.env.CHATLOG_TRUST_PROXY === '1';

function requestMatchesServerOrigin(req) {
    const origin = String(req.get?.('origin') || '').trim();
    if (!origin) return true; // curl·로컬 서버 호출은 ST 인증 계층에 맡긴다.
    try {
        const originHost = new URL(origin).host.toLowerCase();
        const forwardedHost = TRUST_FORWARDED_HOST
            ? String(req.get?.('x-forwarded-host') || '')
                .split(',')[0].trim().toLowerCase()
            : '';
        const requestHost = forwardedHost || String(req.get?.('host') || '').trim().toLowerCase();
        return !!requestHost && originHost === requestHost;
    } catch {
        return false;
    }
}

function loadJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

function atomicWriteJson(targetPath, value) {
    const directory = path.dirname(targetPath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(
        directory,
        `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporaryPath, targetPath);
    } catch (error) {
        try { fs.unlinkSync(temporaryPath); } catch { /* 생성 전 실패 또는 이미 이동됨 */ }
        throw error;
    }
}

function cleanDisplayName(value) {
    let name = String(value || '').trim();
    try { name = decodeURIComponent(name); } catch { /* 이미 일반 문자열 */ }
    name = path.basename(name).replace(/\.(png|jpe?g|webp|gif|avif)$/i, '').trim();
    return name || '캐릭터';
}

function exposesInternalRoleLabel(value) {
    return /(?:유저|페르소나|\buser\b|\bpersona\b)/iu.test(String(value || ''));
}

function secureSettingsUserHandle() {
    const storedUserHandle = String(settings.userHandle || 'default-user').trim();
    const safeHandle = ai.safeUserHandle(storedUserHandle);
    settings.userHandle = safeHandle;
    if (safeHandle !== storedUserHandle) {
        console.warn(`[chatlog] 안전하지 않은 userHandle을 기본값으로 복구: ${storedUserHandle}`);
        saveSettings();
    }
}

function loadAll() {
    db = loadJson(DATA_PATH, db);
    db.rooms ??= {}; db.posts ??= {}; db.jobs ??= [];
    db.runtime ??= {};
    db.runtime.lastTickAt ??= null;
    db.runtime.lastSuccessAt ??= null;
    db.runtime.lastSuccess ??= '';
    db.runtime.lastErrorAt ??= null;
    db.runtime.lastError ??= '';
    db.runtime.lastNoticeAt ??= null;
    db.runtime.lastNotice ??= '';
    db.runtime.skippedMissedSlots ??= 0;
    for (const job of db.jobs) job.attempts ??= 0;
    settings = { ...settings, ...loadJson(SETTINGS_PATH, {}) };
    secureSettingsUserHandle();
    ai.setDebugEnabled(settings.debugEnabled === true);
    // v0.7.12: 텍스트는 ST 프로필, 이미지는 별도 Vertex Express 설정만 사용한다.
    settings.textMode = 'profile';
    settings.imageProvider = 'vertex';

    for (const room of Object.values(db.rooms)) {
        room.slotHistory ??= [];
        room.sharedScenes ??= [];
        room.sharedScenes = room.sharedScenes
            .filter(scene => scene && Number(scene.slotAt) > Date.now() - 7 * 24 * 3600 * 1000)
            .slice(-120);
        room.memberPersonas ??= {};
        room.relationshipGraph ??= {
            version: 2,
            status: 'stale',
            generatedAt: null,
            displayPersona: room.persona
                ? { name: room.persona.name || '유저', avatar: room.persona.avatar || null }
                : null,
            memberRelations: [],
            characterRelations: [],
            summary: '',
            lastError: null,
        };
        if (room.relationshipGraph.status === 'building'
            || room.relationshipGraph.status === 'pending') {
            room.relationshipGraph.status = 'stale';
        }
        room.relationshipGraph.version = 2;
        room.relationshipGraph.memberRelations ??= [];
        room.relationshipGraph.characterRelations ??= [];
        room.schedule ??= {};
        room.schedule.maxSilenceHours ??= 12;
    }

    // 예전 버전에 저장된 캐릭터 게시물/반응도 표시 이름을 복구한다.
    for (const [roomId, posts] of Object.entries(db.posts)) {
        const room = db.rooms[roomId];
        for (const member of room?.members || []) {
            member.name = cleanDisplayName(member.name || member.avatar);
        }
        for (const post of posts) {
            post.comments ??= [];
            post.reactions ??= [];
            post.presentPeople ??= [];
            post.visiblePeople ??= [];
            post.presenceKnown ??= false;
            if (post.author !== 'user') {
                const member = room?.members?.find(m => m.avatar === post.author);
                post.authorName = cleanDisplayName(member?.name || post.authorName || post.author);
            }
            for (const comment of post.comments) {
                if (comment.author !== 'user') {
                    const member = room?.members?.find(m => m.avatar === comment.author);
                    comment.authorName = cleanDisplayName(member?.name || comment.authorName || comment.author);
                }
            }
            for (const reaction of post.reactions) {
                if (reaction.author !== 'user') {
                    const member = room?.members?.find(m => m.avatar === reaction.author);
                    reaction.authorName = cleanDisplayName(member?.name || reaction.authorName || reaction.author);
                }
            }
        }
    }
}

let saveTimer = null;
function flushDbSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    atomicWriteJson(DATA_PATH, db);
}

function saveDb() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try { atomicWriteJson(DATA_PATH, db); }
        catch (e) { console.error('[chatlog] 저장 실패:', e.message); }
    }, 300);
}

function saveSettings() {
    try { atomicWriteJson(SETTINGS_PATH, settings); }
    catch (e) { console.error('[chatlog] 설정 저장 실패:', e.message); }
}

function jobLabel(job, result = null) {
    const room = db.rooms[job.roomId];
    const member = room?.members?.find(item => item.avatar === job.charId);
    if (job.type === 'cut') {
        return result?.status === 'posted'
            ? `${member?.name || '캐릭터'} 게시 성공`
            : `${member?.name || '캐릭터'} 게시 판단 완료`;
    }
    if (job.type === 'engagement') return `${member?.name || '캐릭터'} 댓글·반응 완료`;
    if (job.type === 'comment') return `${member?.name || '캐릭터'} 댓글 완료`;
    if (job.type === 'reaction') return `${member?.name || '캐릭터'} 반응 완료`;
    return `${job.type || '작업'} 완료`;
}

function markJobSuccess(job, result) {
    db.runtime.lastSuccessAt = Date.now();
    db.runtime.lastSuccess = jobLabel(job, result);
}

function markJobError(job, error, retryAt = null) {
    db.runtime.lastErrorAt = Date.now();
    db.runtime.lastError = `${jobLabel(job).replace(/ 완료$/, '')}: ${sanitizeRuntimeError(error.message)}`
        + (retryAt ? ` · ${new Date(retryAt).toLocaleTimeString('ko-KR')} 재시도` : '');
}

function statusPayload() {
    const nextSlotAt = Object.values(db.rooms)
        .filter(room => !room.paused && Number.isFinite(room.nextSlotAt))
        .reduce((earliest, room) => Math.min(earliest, room.nextSlotAt), Infinity);
    return {
        serverTime: Date.now(),
        lastTickAt: db.runtime.lastTickAt,
        lastSuccessAt: db.runtime.lastSuccessAt,
        lastSuccess: db.runtime.lastSuccess,
        lastErrorAt: db.runtime.lastErrorAt,
        lastError: db.runtime.lastError,
        lastNoticeAt: db.runtime.lastNoticeAt,
        lastNotice: db.runtime.lastNotice,
        skippedMissedSlots: db.runtime.skippedMissedSlots,
        pendingJobs: db.jobs.length,
        retryingJobs: db.jobs.filter(job => Number(job.attempts) > 0).length,
        nextSlotAt: Number.isFinite(nextSlotAt) ? nextSlotAt : null,
    };
}

const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
function validRecordId(value, prefix) {
    const normalized = String(value || '');
    return normalized.length <= 128
        && normalized.startsWith(`${prefix}_`)
        && /^[a-z0-9_]+$/i.test(normalized);
}

// roomId가 생략 가능한 엔드포인트용. 값이 있으면 반드시 정상 room ID여야 한다.
// 검사를 빠뜨리면 "__proto__" 같은 값이 db.rooms 조회를 통과해
// Object.prototype을 방 객체로 오인하게 만든다.
function validOptionalRoomId(value) {
    return value === undefined || value === null || value === ''
        ? true
        : validRecordId(value, 'room');
}

const VALID_JOB_TYPES = new Set(['cut', 'comment', 'engagement', 'reaction']);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function limitedString(value, maxLength, { required = false, trim = true } = {}) {
    if (typeof value !== 'string') {
        if (required) throw new TypeError('required string is missing');
        return '';
    }
    const normalized = trim ? value.trim() : value;
    if ((required && !normalized) || normalized.length > maxLength || normalized.includes('\0')) {
        throw new TypeError('invalid string');
    }
    return normalized;
}

function normalizeAssetName(value, { required = false } = {}) {
    const normalized = limitedString(value, 260, { required });
    if (normalized && (/[\\/]/.test(normalized) || normalized === '.' || normalized === '..')) {
        throw new TypeError('invalid asset name');
    }
    return normalized || null;
}

function normalizeMemberInput(member) {
    if (!isPlainRecord(member)) throw new TypeError('invalid room member');
    const avatar = normalizeAssetName(member.avatar, { required: true });
    return {
        avatar,
        name: cleanDisplayName(limitedString(member.name || avatar, 120, { required: true })),
        description: limitedString(member.description || '', 60000, { trim: false }),
        personality: limitedString(member.personality || '', 30000, { trim: false }),
        scenario: limitedString(member.scenario || '', 30000, { trim: false }),
        mesExample: limitedString(member.mesExample || '', 30000, { trim: false }),
    };
}

function normalizeMembersInput(members) {
    if (!Array.isArray(members) || members.length < 1 || members.length > 100) {
        throw new TypeError('invalid room members');
    }
    const normalized = members.map(normalizeMemberInput);
    const avatars = normalized.map(member => member.avatar);
    if (new Set(avatars).size !== avatars.length) throw new TypeError('duplicate room member');
    return normalized;
}

function normalizePersonaInput(persona) {
    if (persona === null || persona === undefined) return null;
    if (!isPlainRecord(persona)) throw new TypeError('invalid persona');
    return {
        name: limitedString(persona.name || '유저', 120, { required: true }),
        description: limitedString(persona.description || '', 60000, { trim: false }),
        avatar: normalizeAssetName(persona.avatar),
        file: normalizeAssetName(persona.file),
    };
}

function normalizeMemberPersonasInput(memberPersonas, members) {
    if (memberPersonas === null || memberPersonas === undefined) return {};
    if (!isPlainRecord(memberPersonas)) throw new TypeError('invalid member personas');
    const knownMembers = new Set((members || []).map(member => member.avatar));
    const entries = Object.entries(memberPersonas);
    if (entries.length > Math.max(100, knownMembers.size)) {
        throw new TypeError('too many member personas');
    }
    const normalized = Object.create(null);
    for (const [memberId, persona] of entries) {
        if (DANGEROUS_OBJECT_KEYS.has(memberId) || !knownMembers.has(memberId)) {
            throw new TypeError('invalid member persona key');
        }
        normalized[memberId] = normalizePersonaInput(persona);
    }
    return normalized;
}

function normalizeScheduleInput(schedule, fallback = {}) {
    if (!isPlainRecord(schedule)) throw new TypeError('invalid room schedule');
    const allowed = new Set([
        'activeFrom',
        'activeTo',
        'cutIntervalHours',
        'maxSilenceHours',
        'jitter',
    ]);
    if (Object.keys(schedule).some(key => !allowed.has(key))) {
        throw new TypeError('invalid room schedule field');
    }
    const numberInRange = (key, defaultValue, min, max) => {
        const raw = schedule[key] ?? fallback[key] ?? defaultValue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new TypeError(`invalid ${key}`);
        }
        return value;
    };
    const normalized = {
        activeFrom: numberInRange('activeFrom', 8, 0, 23),
        activeTo: numberInRange('activeTo', 24, 1, 24),
        cutIntervalHours: numberInRange('cutIntervalHours', 2, 1, 168),
        maxSilenceHours: numberInRange('maxSilenceHours', 12, 1, 720),
        jitter: schedule.jitter ?? fallback.jitter ?? true,
    };
    if (normalized.activeFrom >= normalized.activeTo || typeof normalized.jitter !== 'boolean') {
        throw new TypeError('invalid room schedule');
    }
    return normalized;
}

function normalizeManualRelations(room, value, kind) {
    if (!Array.isArray(value) || value.length > 10000) {
        throw new TypeError(`invalid ${kind}`);
    }
    const knownMembers = new Set((room.members || []).map(member => member.avatar));
    return value.map(item => {
        if (!isPlainRecord(item)) throw new TypeError(`invalid ${kind}`);
        const normalized = { ...item };
        for (const [key, fieldValue] of Object.entries(normalized)) {
            if (DANGEROUS_OBJECT_KEYS.has(key)) throw new TypeError(`invalid ${kind}`);
            if (typeof fieldValue === 'string' && fieldValue.length > 1000) {
                normalized[key] = fieldValue.slice(0, 1000);
            }
        }
        const ids = kind === 'memberRelations'
            ? [normalized.memberAvatar]
            : [normalized.aAvatar, normalized.bAvatar];
        if (ids.some(id => typeof id !== 'string' || !knownMembers.has(id))) {
            throw new TypeError(`unknown member in ${kind}`);
        }
        return { ...normalized, confidence: 'manual', locked: true };
    });
}

// 프로바이더 오류 본문에는 프로젝트 ID 등이 섞일 수 있어
// /status로 그대로 내보내지 않는다.
function sanitizeRuntimeError(message) {
    const normalized = String(message || '').replace(/\s+/g, ' ').trim();
    const bodyStart = normalized.search(/[:\s][{[]/);
    const summary = bodyStart >= 0 ? normalized.slice(0, bodyStart) : normalized;
    return summary
        .replace(/https?:\/\/\S+/gi, '[endpoint]')
        .replace(/\bprojects?[\/#:\s]+[a-z0-9._-]+/gi, 'project [redacted]')
        .replace(/\b(?:api[_ -]?key|key|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
        .slice(0, 200);
}
const rand = (min, max) => min + Math.random() * (max - min);
const COMMENT_INTENTS = ['detail', 'tease', 'question', 'opinion', 'practical', 'callback', 'minimal'];
const SHARED_SCENE_TEMPLATES = [
    {
        type: 'cafe',
        locationKo: '동네 카페',
        locationEn: 'the same cozy neighborhood cafe',
        anchorEn: 'the same table, window direction, cups, tabletop material, interior palette and daylight',
    },
    {
        type: 'meal',
        locationKo: '식당',
        locationEn: 'the same casual restaurant',
        anchorEn: 'the same table, dishes, seating arrangement, wall colors and ambient lighting',
    },
    {
        type: 'park',
        locationKo: '공원',
        locationEn: 'the same nearby park',
        anchorEn: 'the same path, benches, trees, sky, weather and direction of sunlight',
    },
    {
        type: 'shopping',
        locationKo: '상점가',
        locationEn: 'the same shopping street',
        anchorEn: 'the same storefronts, bags, pavement, crowd level and natural light',
    },
    {
        type: 'workout',
        locationKo: '운동 공간',
        locationEn: 'the same gym or practice space',
        anchorEn: 'the same equipment, lockers, floor, windows and overhead lighting',
    },
    {
        type: 'hangout',
        locationKo: '편하게 모인 실내 공간',
        locationEn: 'the same relaxed indoor hangout space',
        anchorEn: 'the same sofa or table, room layout, shared objects, window light and lamps',
    },
];

function shuffled(values) {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index--) {
        const target = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[target]] = [copy[target], copy[index]];
    }
    return copy;
}

function clampPercent(value, fallback = 0) {
    const number = Number(value);
    return Math.max(0, Math.min(100, Number.isFinite(number) ? number : fallback));
}

function exactCharacterRelation(room, aAvatar, bAvatar) {
    return (room.relationshipGraph?.characterRelations || []).find(relation =>
        ['explicit', 'manual'].includes(relation?.confidence)
        && ((relation.aAvatar === aAvatar && relation.bAvatar === bAvatar)
            || (relation.aAvatar === bAvatar && relation.bAvatar === aAvatar))) || null;
}

function relationMeetupWeight(room, aAvatar, bAvatar) {
    const relation = exactCharacterRelation(room, aAvatar, bAvatar);
    if (!relation) return 26;
    return {
        spouse: 100,
        romantic: 96,
        close_friend: 92,
        family: 86,
        friend: 78,
        colleague: 58,
        custom: 62,
        acquaintance: 42,
        rival: 28,
        ex: 22,
        hostile: 4,
        unknown: 24,
    }[relation.type] ?? 30;
}

function memberSocialWeight(member) {
    const card = `${member?.personality || ''} ${member?.description || ''}`.toLowerCase();
    let weight = 50;
    if (/(?:사교|외향|활발|친화|장난|파티|social|outgoing|extrovert|friendly|playful)/iu.test(card)) weight += 24;
    if (/(?:내향|과묵|무뚝뚝|고독|사적|바쁨|introvert|reserved|private|solitary|busy)/iu.test(card)) weight -= 18;
    return Math.max(12, weight);
}

function weightedPick(items, weightOf) {
    if (!items.length) return null;
    const weighted = items.map(item => ({
        item,
        weight: Math.max(0, Number(weightOf(item)) || 0),
    }));
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) return items[Math.floor(Math.random() * items.length)];
    let roll = Math.random() * total;
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll <= 0) return entry.item;
    }
    return weighted.at(-1).item;
}

function createSharedScenePlan(room, slotAt, candidates = room.members || []) {
    if (candidates.length < 2
        || Math.random() * 100 >= clampPercent(settings.roomMeetupChance, 28)) {
        return null;
    }

    const lead = weightedPick(candidates, member => memberSocialWeight(member));
    if (!lead) return null;
    const participantCount = Math.min(
        candidates.length,
        Math.random() < 0.36 ? 3 : 2,
    );
    const participants = [lead];
    const remaining = candidates.filter(member => member.avatar !== lead.avatar);
    while (participants.length < participantCount && remaining.length) {
        const next = weightedPick(remaining, member =>
            relationMeetupWeight(room, lead.avatar, member.avatar)
            + Math.round(memberSocialWeight(member) * 0.25));
        if (!next) break;
        participants.push(next);
        remaining.splice(remaining.findIndex(member => member.avatar === next.avatar), 1);
    }
    if (participants.length < 2) return null;

    const template = SHARED_SCENE_TEMPLATES[
        Math.floor(Math.random() * SHARED_SCENE_TEMPLATES.length)
    ];
    const scene = {
        id: uid('scene'),
        slotAt,
        leadAvatar: lead.avatar,
        participantIds: participants.map(member => member.avatar),
        participantNames: participants.map(member => member.name),
        type: template.type,
        locationKo: template.locationKo,
        locationEn: template.locationEn,
        anchorEn: template.anchorEn,
        continuity: '',
        posts: [],
        createdAt: Date.now(),
        expiresAt: slotAt + 2 * 3600 * 1000,
    };
    room.sharedScenes ??= [];
    room.sharedScenes.push(scene);
    if (room.sharedScenes.length > 120) {
        room.sharedScenes.splice(0, room.sharedScenes.length - 120);
    }
    return scene;
}

function findSharedScene(room, sceneId) {
    if (!sceneId) return null;
    return (room.sharedScenes || []).find(scene => scene.id === sceneId) || null;
}

function sharedSceneDisplayAt(scene) {
    const scheduled = new Date(Number(scene?.slotAt) || Date.now());
    const hourStart = new Date(scheduled);
    hourStart.setMinutes(0, 0, 0);
    const firstMinute = Math.min(50, Math.max(0, scheduled.getMinutes()));
    const postIndex = Math.max(0, Number(scene?.posts?.length || 0));
    const minute = Math.min(58, firstMinute + postIndex * 6);
    return hourStart.getTime() + minute * 60 * 1000;
}

function sharedScenePeople(room, scene) {
    return (scene?.participantIds || [])
        .map(avatar => room.members.find(member => member.avatar === avatar))
        .filter(Boolean)
        .map(member => ({
            kind: 'character',
            id: member.avatar,
            name: member.name,
            avatar: member.avatar,
        }));
}

function chooseVisibleSceneCompanions(scene, member) {
    const candidates = shuffled(
        (scene?.participantIds || []).filter(avatar => avatar !== member.avatar),
    );
    if (!candidates.length || Math.random() >= 0.68) return [];
    const count = candidates.length > 1 && Math.random() < 0.32 ? 2 : 1;
    return candidates.slice(0, count);
}

function spreadTimes(startAt, count, windowMinutes = 48) {
    if (count <= 0) return [];
    const stepMs = Math.max(60 * 1000, windowMinutes * 60 * 1000 / count);
    return Array.from({ length: count }, (_, index) =>
        Math.round(startAt + index * stepMs + rand(60 * 1000, Math.max(90 * 1000, stepMs * 0.72))));
}

// ── 스케줄 계산 ───────────────────────────────────────────
function computeNextSlot(room, from = Date.now()) {
    const s = room.schedule || {};
    const activeFrom = s.activeFrom ?? 8;
    const activeTo = s.activeTo ?? 24;
    const hours = Math.max(1, s.cutIntervalHours ?? 2);

    let next;
    if (s.jitter !== false) {
        // 간격 ±25% 흔들기. 재시작해도 안 흔들리게 결과를 저장해서 씀.
        next = new Date(from + rand(hours * 0.75, hours * 1.25) * 3600 * 1000);
    } else {
        next = new Date(from + hours * 3600 * 1000);
        next.setMinutes(0, 0, 0);
    }

    const h = next.getHours();
    if (h < activeFrom) {
        next.setHours(activeFrom, 0, 0, 0);
    } else if (h >= activeTo) {
        next.setDate(next.getDate() + 1);
        next.setHours(activeFrom, 0, 0, 0);
    }
    return next.getTime();
}

function recordSlot(room, slotAt) {
    room.slotHistory ??= [];
    if (!room.slotHistory.some(ts => Math.abs(ts - slotAt) < 60000)) {
        room.slotHistory.push(slotAt);
        room.slotHistory.sort((a, b) => a - b);
        if (room.slotHistory.length > 500) room.slotHistory.splice(0, room.slotHistory.length - 500);
    }
}

function activeHoursBetween(from, to, schedule = {}) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Infinity;
    if (to <= from) return 0;

    const activeFrom = schedule.activeFrom ?? 8;
    const activeTo = schedule.activeTo ?? 24;
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const lastDay = new Date(to);
    lastDay.setHours(0, 0, 0, 0);

    let totalMs = 0;
    let guard = 0;
    while (cursor <= lastDay) {
        if (guard++ > 370) return Infinity;
        const windowStart = new Date(cursor);
        const windowEnd = new Date(cursor);
        windowStart.setHours(activeFrom, 0, 0, 0);
        windowEnd.setHours(activeTo, 0, 0, 0);
        const overlapStart = Math.max(from, windowStart.getTime());
        const overlapEnd = Math.min(to, windowEnd.getTime());
        if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
        cursor.setDate(cursor.getDate() + 1);
    }
    return totalMs / 3600000;
}

// ── 작업 큐 ───────────────────────────────────────────────
function enqueueEngagement(room, post) {
    const minMs = Math.max(10 * 1000, settings.commentDelayMinMin * 30000);
    const maxMs = Math.max(minMs, settings.commentDelayMaxMin * 60000);
    const members = shuffled(room.members.filter(member => member.avatar !== post.author));
    const intents = shuffled(COMMENT_INTENTS);
    for (const [index, member] of members.entries()) {
        const commentWanted = post.author === 'user'
            || Math.random() * 100 < Math.max(0, Math.min(100, settings.characterCommentChance));
        db.jobs.push({
            id: uid('job'),
            type: 'engagement',
            roomId: room.id,
            postId: post.id,
            charId: member.avatar,
            commentWanted,
            commentIntent: intents[index % intents.length],
            attempts: 0,
            runAt: Date.now() + rand(minMs, maxMs),
        });
    }
    saveDb();
}

const findPost = (roomId, postId) => {
    if (!validRecordId(roomId, 'room') || !validRecordId(postId, 'post')) return null;
    return (db.posts[roomId] || []).find(p => p.id === postId);
};
const findMember = (room, avatar) => room.members.find(m => m.avatar === avatar);
function recentRoomCommentTexts(roomId, excludePostId = null, limit = 18) {
    return (db.posts[roomId] || [])
        .filter(post => post.id !== excludePostId)
        .flatMap(post => (post.comments || [])
            .filter(comment => comment.author !== 'user' && comment.text)
            .map(comment => ({
                text: String(comment.text).trim(),
                createdAt: Number(comment.createdAt || post.createdAt || 0),
            })))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(item => item.text);
}
function hasCharacterPostInSlot(roomId, charId, slotAt) {
    const key = ai.hourSlotKey(slotAt);
    return (db.posts[roomId] || []).some(post => post.author === charId
        && ai.hourSlotKey(post.slotAt ?? post.createdAt) === key);
}
function hasQueuedCharacterCut(roomId, charId, slotAt) {
    const key = ai.hourSlotKey(slotAt);
    return db.jobs.some(job => job.type === 'cut'
        && job.roomId === roomId
        && job.charId === charId
        && ai.hourSlotKey(job.slotAt) === key);
}

async function runJob(job) {
    const room = db.rooms[job.roomId];
    if (!room) return;

    if (job.type === 'comment') {
        const post = findPost(job.roomId, job.postId);
        if (!post) return;
        const member = findMember(room, job.charId);
        if (!member) return;
        const text = await ai.generateComment(settings, room, post, member, {
            replyToCommentId: job.replyToCommentId,
            commentIntent: job.commentIntent,
            recentComments: recentRoomCommentTexts(job.roomId, job.postId),
        });
        if (!text || exposesInternalRoleLabel(text)) {
            return { status: 'comment-skipped', commented: false };
        }
        post.comments.push({
            id: uid('c'),
            author: member.avatar,
            authorName: member.name,
            text,
            replyTo: job.replyToCommentId || null,
            createdAt: Date.now(), read: false,
        });
        return { status: 'commented', commented: true };
    }

    if (job.type === 'reaction') {
        const post = findPost(job.roomId, job.postId);
        if (!post) return;
        const member = findMember(room, job.charId);
        if (!member || member.avatar === post.author) return;
        post.reactions ??= [];
        const emoji = await ai.generateReaction(settings, room, post, member);
        const existing = post.reactions.findIndex(r => r.author === member.avatar);
        const reaction = {
            author: member.avatar,
            authorName: member.name,
            emoji,
            createdAt: Date.now(),
        };
        if (existing >= 0) post.reactions.splice(existing, 1, reaction);
        else post.reactions.push(reaction);
        return { status: 'reacted', reacted: true };
    }

    if (job.type === 'engagement') {
        const post = findPost(job.roomId, job.postId);
        if (!post) return;
        const member = findMember(room, job.charId);
        if (!member || member.avatar === post.author) return;
        const result = await ai.generateEngagement(settings, room, post, member, {
            commentWanted: job.commentWanted === true,
            commentIntent: job.commentIntent,
            recentComments: recentRoomCommentTexts(job.roomId, job.postId),
        });
        post.reactions ??= [];
        const existing = post.reactions.findIndex(reaction => reaction.author === member.avatar);
        const reaction = {
            author: member.avatar,
            authorName: member.name,
            emoji: result.emoji,
            createdAt: Date.now(),
        };
        if (existing >= 0) post.reactions.splice(existing, 1, reaction);
        else post.reactions.push(reaction);

        if (result.comment) {
            post.comments.push({
                id: uid('c'),
                author: member.avatar,
                authorName: member.name,
                text: result.comment,
                replyTo: null,
                createdAt: Date.now(),
                read: false,
            });
        }
        return { status: 'engaged', commented: !!result.comment, reacted: true };
    }

    if (job.type === 'cut') {
        const member = findMember(room, job.charId);
        if (!member) return;
        const sharedScene = findSharedScene(room, job.sharedSceneId);
        // 공동 장면의 여러 시점은 실제 생성이 조금 늦어져도 같은 시간 탭에 묶는다.
        // 분 단위는 6분씩 벌려 동시에 도배된 것처럼 보이지 않게 한다.
        const effectiveSlotAt = sharedScene
            ? sharedSceneDisplayAt(sharedScene)
            : Date.now();
        if (hasCharacterPostInSlot(room.id, member.avatar, effectiveSlotAt)) {
            return { status: 'duplicate-skipped' };
        }
        const previous = (db.posts[room.id] || [])
            .filter(post => post.author === member.avatar)
            .sort((a, b) => (b.slotAt ?? b.createdAt) - (a.slotAt ?? a.createdAt))[0];
        const lastPostAt = previous?.slotAt ?? previous?.createdAt ?? room.createdAt;
        const maxSilenceHours = Math.max(
            room.schedule?.cutIntervalHours ?? 2,
            room.schedule?.maxSilenceHours ?? 12,
        );
        const forcePost = !!job.forcePost
            || activeHoursBetween(lastPostAt, effectiveSlotAt, room.schedule) >= maxSilenceHours;
        const recentCharacterPosts = (db.posts[room.id] || [])
            .filter(post => post.author === member.avatar && post.photoMode)
            .sort((a, b) => (b.slotAt ?? b.createdAt) - (a.slotAt ?? a.createdAt));
        const recentPhotoModes = recentCharacterPosts.map(post => post.photoMode);
        const recentCompanionFlags = recentCharacterPosts
            .filter(post => post.photoMode === 'selfie')
            .map(post => post.withPersona === true);
        const photoDecision = ai.choosePhotoMode(
            member,
            Math.floor(rand(0, 100)),
            recentPhotoModes,
            settings.selfiePhotoChance ?? 50,
        );
        const sharedVisibleMemberIds = sharedScene && photoDecision.photoMode === 'selfie'
            ? chooseVisibleSceneCompanions(sharedScene, member)
            : [];
        const result = await ai.generateCharacterCut(settings, room, member, effectiveSlotAt, {
            forcePost,
            randomRoll: Math.floor(rand(0, 100)),
            companionRoll: Math.floor(rand(0, 100)),
            recentCompanionFlags,
            sharedScene,
            sharedVisibleMemberIds,
            activeHoursSinceLastPost: activeHoursBetween(lastPostAt, effectiveSlotAt, room.schedule),
            maxSilenceHours,
            ...photoDecision,
        });
        if (result.skipped) return { status: 'skipped' };
        if (hasCharacterPostInSlot(room.id, member.avatar, effectiveSlotAt)) {
            return { status: 'duplicate-skipped' };
        }
        const {
            text,
            image,
            photoMode,
            withPersona = false,
            companionName = null,
            sceneContinuity = '',
            sceneViewpoint = '',
            presentPeople = [],
            visiblePeople = [],
        } = result;
        if (sharedScene) {
            if (!sharedScene.continuity && sceneContinuity) {
                sharedScene.continuity = String(sceneContinuity).slice(0, 500);
            }
            sharedScene.posts ??= [];
            sharedScene.posts.push({
                author: member.avatar,
                authorName: member.name,
                photoMode,
                viewpoint: String(sceneViewpoint || '').slice(0, 160),
                createdAt: Date.now(),
            });
        }
        const normalizedPresentPeople = presentPeople.length
            ? presentPeople
            : sharedScene ? sharedScenePeople(room, sharedScene) : [];
        const post = {
            id: uid('post'), roomId: room.id, author: job.charId,
            authorName: member.name,
            slotAt: effectiveSlotAt, createdAt: Date.now(),
            text, image, imageSource: 'generated', photoMode,
            withPersona, companionName,
            sceneId: sharedScene?.id || null,
            sceneContext: sharedScene
                ? {
                    type: sharedScene.type,
                    locationKo: sharedScene.locationKo,
                    locationEn: sharedScene.locationEn,
                    anchorEn: sharedScene.anchorEn,
                    continuity: sharedScene.continuity || sceneContinuity || '',
                }
                : null,
            presenceKnown: true,
            presentPeople: normalizedPresentPeople,
            visiblePeople,
            read: false, comments: [], reactions: [],
        };
        (db.posts[room.id] ??= []).push(post);
        enqueueEngagement(room, post);
        return { status: 'posted', post };
    }
}

function retryableJobError(error) {
    const message = String(error?.message || '');
    if (/(?:400|401|403|invalid api|api 키|연결 프로필을 찾을 수 없음|프로젝트 ID|화자 ID 검증 실패|참조 프사가 없어|이미지 데이터 없음|이미지를 만들지 못해)/i.test(message)) {
        return false;
    }
    return true;
}

async function executeJob(job, allowRetry = true) {
    try {
        const result = await runJob(job);
        markJobSuccess(job, result);
        return result;
    } catch (error) {
        const attempts = Number(job.attempts || 0) + 1;
        const canRetry = allowRetry
            && retryableJobError(error)
            && attempts < RETRY_DELAYS_MS.length + 1;
        if (canRetry) {
            const retryAt = Date.now() + RETRY_DELAYS_MS[attempts - 1];
            db.jobs.push({
                ...job,
                attempts,
                lastError: sanitizeRuntimeError(error.message),
                runAt: retryAt,
            });
            markJobError(job, error, retryAt);
            console.warn(`[chatlog] 작업 재시도 예약 (${attempts}/3):`, job.type, error.message);
            return {
                status: 'retrying',
                retryAt,
                error: sanitizeRuntimeError(error.message),
            };
        }
        markJobError(job, error);
        throw error;
    }
}

// ── 자동 정리 ─────────────────────────────────────────────
// chatlog가 관리하는 이미지 폴더 (이 밖의 파일은 절대 삭제하지 않음)
const PUBLIC_DIR = path.resolve(ST_ROOT, 'public');
const CHATLOG_IMAGE_DIR = path.resolve(ST_ROOT, 'public', 'user', 'images', 'chatlog');
const CHATLOG_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const MAX_MANUAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MANUAL_IMAGE_BASE64_LENGTH = Math.ceil(MAX_MANUAL_IMAGE_BYTES * 4 / 3) + 16;

function imageUploadError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function detectImageType(buffer) {
    if (buffer.length >= 8
        && buffer[0] === 0x89
        && buffer.subarray(1, 8).equals(Buffer.from([0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { ext: 'png', mime: 'image/png' };
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { ext: 'jpg', mime: 'image/jpeg' };
    }
    if (buffer.length >= 6) {
        const signature = buffer.subarray(0, 6).toString('ascii');
        if (signature === 'GIF87a' || signature === 'GIF89a') {
            return { ext: 'gif', mime: 'image/gif' };
        }
    }
    if (buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return { ext: 'webp', mime: 'image/webp' };
    }
    if (buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString('ascii');
        if (brands.includes('avif') || brands.includes('avis')) {
            return { ext: 'avif', mime: 'image/avif' };
        }
    }
    return null;
}

function decodeManualImage(imageBase64, mimeHint) {
    if (typeof mimeHint !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeHint)) {
        throw imageUploadError('이미지 형식 정보가 올바르지 않아요.');
    }
    if (typeof imageBase64 !== 'string') {
        throw imageUploadError('이미지 데이터가 없어요.');
    }

    const encoded = imageBase64.replace(/\s+/g, '');
    if (!encoded) throw imageUploadError('이미지 데이터가 없어요.');
    if (encoded.length > MAX_MANUAL_IMAGE_BASE64_LENGTH) {
        throw imageUploadError('사진은 최대 20MB까지 올릴 수 있어요.', 413);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
        throw imageUploadError('이미지 데이터가 손상되었어요.');
    }

    const padded = encoded.padEnd(encoded.length + ((4 - encoded.length % 4) % 4), '=');
    const buffer = Buffer.from(padded, 'base64');
    if (!buffer.length) throw imageUploadError('이미지 데이터가 없어요.');
    if (buffer.length > MAX_MANUAL_IMAGE_BYTES) {
        throw imageUploadError('사진은 최대 20MB까지 올릴 수 있어요.', 413);
    }

    const type = detectImageType(buffer);
    if (!type) {
        throw imageUploadError('지원하지 않거나 손상된 사진이에요. PNG, JPG, WebP, GIF, AVIF만 지원해요.');
    }
    return { buffer, type };
}

function saveManualImage(imageBase64, mimeHint) {
    const { buffer, type } = decodeManualImage(imageBase64, mimeHint);
    const sanitized = stripImagePrivacyMetadata(buffer, type);
    fs.mkdirSync(CHATLOG_IMAGE_DIR, { recursive: true });
    const imageRootStat = fs.lstatSync(CHATLOG_IMAGE_DIR);
    const realPublicRoot = fs.realpathSync(PUBLIC_DIR);
    const realImageRoot = fs.realpathSync(CHATLOG_IMAGE_DIR);
    if (!imageRootStat.isDirectory()
        || imageRootStat.isSymbolicLink()
        || !isPathInside(realPublicRoot, realImageRoot)) {
        throw imageUploadError('챗로그 사진 폴더의 실제 경로가 올바르지 않아요.');
    }
    const filename = `${uid('post')}.${type.ext}`;
    const absolutePath = path.join(realImageRoot, filename);
    fs.writeFileSync(absolutePath, sanitized.buffer, { flag: 'wx' });
    return `/user/images/chatlog/${filename}`;
}

function isPathInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return !!relative
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function resolveChatlogImage(webPath, requireExisting = false) {
    if (!webPath || typeof webPath !== 'string' || webPath.includes('\0')) return null;
    const abs = path.resolve(PUBLIC_DIR, webPath.replace(/^\/+/, ''));
    if (!isPathInside(CHATLOG_IMAGE_DIR, abs)
        || !CHATLOG_IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
        return null;
    }
    if (!requireExisting) return abs;
    try {
        const imageRootStat = fs.lstatSync(CHATLOG_IMAGE_DIR);
        const stat = fs.lstatSync(abs);
        if (!imageRootStat.isDirectory()
            || imageRootStat.isSymbolicLink()
            || !stat.isFile()
            || stat.isSymbolicLink()) return null;
        const realPublicRoot = fs.realpathSync(PUBLIC_DIR);
        const realImageRoot = fs.realpathSync(CHATLOG_IMAGE_DIR);
        const realFile = fs.realpathSync(abs);
        return isPathInside(realPublicRoot, realImageRoot)
            && isPathInside(realImageRoot, realFile)
            ? abs
            : null;
    } catch {
        return null;
    }
}

function removeImageFile(webPath) {
    // 글만 있는 게시물은 삭제할 이미지 자체가 없다.
    if (!webPath) return;
    const abs = resolveChatlogImage(webPath, true);
    if (!abs) {
        console.warn('[chatlog] 이미지 삭제 거부 (chatlog 폴더 밖):', webPath);
        return;
    }
    try {
        fs.unlinkSync(abs);
    } catch { /* 이미 없으면 무시 */ }
}

let lastCleanup = 0;
function runCleanup() {
    if (!settings.autoCleanup) return;

    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Math.max(0, settings.cleanupAfterDays));
    const cutoffTs = cutoff.getTime();

    let removed = 0;
    for (const roomId of Object.keys(db.posts)) {
        db.posts[roomId] = db.posts[roomId].filter(p => {
            if (p.createdAt >= cutoffTs) return true;
            if (settings.keepSaved && p.saved) return true;
            removeImageFile(p.image);
            removed++;
            return false;
        });
    }
    let removedSlots = 0;
    for (const room of Object.values(db.rooms)) {
        const before = (room.slotHistory || []).length;
        room.slotHistory = (room.slotHistory || []).filter(ts => ts >= cutoffTs);
        removedSlots += before - room.slotHistory.length;
        room.sharedScenes = (room.sharedScenes || [])
            .filter(scene => Number(scene?.slotAt || 0) >= cutoffTs)
            .slice(-120);
    }

    // 하루로그 내보내기 파일도 같이 정리
    const exportDir = path.resolve(CHATLOG_IMAGE_DIR, 'daylog');
    try {
        const imageRootStat = fs.lstatSync(CHATLOG_IMAGE_DIR);
        const exportDirStat = fs.lstatSync(exportDir);
        if (!imageRootStat.isDirectory()
            || imageRootStat.isSymbolicLink()
            || !exportDirStat.isDirectory()
            || exportDirStat.isSymbolicLink()) {
            throw new Error('하루로그 폴더가 실제 디렉터리가 아닙니다');
        }
        const realImageRoot = fs.realpathSync(CHATLOG_IMAGE_DIR);
        const realExportDir = fs.realpathSync(exportDir);
        if (!isPathInside(realImageRoot, realExportDir)) {
            throw new Error('하루로그 폴더가 이미지 루트 밖을 가리킵니다');
        }
        for (const f of fs.readdirSync(exportDir)) {
            const fp = path.resolve(realExportDir, f);
            if (!isPathInside(realExportDir, fp)) {
                console.warn('[chatlog] 하루로그 삭제 거부 (폴더 밖):', f);
                continue;
            }
            const stat = fs.lstatSync(fp);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            const realFile = fs.realpathSync(fp);
            if (!isPathInside(realExportDir, realFile)) {
                console.warn('[chatlog] 하루로그 삭제 거부 (실제 경로 밖):', f);
                continue;
            }
            if (stat.mtimeMs < cutoffTs) { fs.unlinkSync(realFile); removed++; }
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn('[chatlog] 하루로그 자동 정리 건너뜀:', error.message);
        }
    }

    if (removed || removedSlots) {
        console.log(`[chatlog] 자동 정리: 기록 ${removed}건, 빈 슬롯 ${removedSlots}건 삭제`);
        saveDb();
    }
}

function isActiveAt(room, timestamp) {
    const hour = new Date(timestamp).getHours();
    const from = room.schedule?.activeFrom ?? 8;
    const to = room.schedule?.activeTo ?? 24;
    return hour >= from && hour < to;
}

function latestPostAtForMember(room, member) {
    const previous = (db.posts[room.id] || [])
        .filter(post => post.author === member.avatar)
        .sort((a, b) => (b.slotAt ?? b.createdAt) - (a.slotAt ?? a.createdAt))[0];
    return previous?.slotAt ?? previous?.createdAt ?? room.createdAt;
}

function skipMissedSlots(room, now) {
    db.runtime.skippedMissedSlots += 1;
        const overdueMembers = [];
    if (isActiveAt(room, now)) {
        for (const member of room.members) {
            const maxSilenceHours = Math.max(
                room.schedule?.cutIntervalHours ?? 2,
                room.schedule?.maxSilenceHours ?? 12,
            );
            const activeGap = activeHoursBetween(
                latestPostAtForMember(room, member),
                now,
                room.schedule,
            );
            const alreadyQueued = db.jobs.some(job => job.type === 'cut'
                && job.roomId === room.id
                && job.charId === member.avatar);
            if (activeGap >= maxSilenceHours && !alreadyQueued) {
                overdueMembers.push(member);
            }
        }
    }
    const resumedTimes = spreadTimes(now, overdueMembers.length, Math.min(42, Math.max(12, overdueMembers.length * 9)));
    overdueMembers.forEach((member, index) => {
        db.jobs.push({
            id: uid('job'),
            type: 'cut',
            roomId: room.id,
            charId: member.avatar,
            slotAt: now,
            runAt: resumedTimes[index],
            forcePost: true,
            attempts: 0,
            resumedAfterGap: true,
        });
    });
    if (overdueMembers.length) recordSlot(room, now);
    room.nextSlotAt = computeNextSlot(room, now);
    db.runtime.lastNoticeAt = now;
    db.runtime.lastNotice = `${room.name}: 밀린 슬롯 건너뜀`
        + (overdueMembers.length ? ` · 최대 공백 ${overdueMembers.length}명 현재 시각 재개` : '');
}

// ── 매분 틱 ───────────────────────────────────────────────
let ticking = false;
let tickTimer = null;
async function tick() {
    if (ticking) return;
    ticking = true;
    const now = Date.now();

    try {
        db.runtime.lastTickAt = now;
        for (const room of Object.values(db.rooms)) {
            if (room.paused) continue;
            if (!room.nextSlotAt) { room.nextSlotAt = computeNextSlot(room); continue; }
            if (room.nextSlotAt > now) continue;
            if (now - room.nextSlotAt > MISSED_SLOT_GRACE_MS) {
                skipMissedSlots(room, now);
                continue;
            }

            const slotAt = room.nextSlotAt;
            recordSlot(room, slotAt);
            const candidates = room.members.filter(member =>
                !hasCharacterPostInSlot(room.id, member.avatar, slotAt)
                && !hasQueuedCharacterCut(room.id, member.avatar, slotAt));
            const sharedScene = createSharedScenePlan(room, slotAt, candidates);
            const followupChance = clampPercent(settings.sharedScenePostChance, 55);
            const eligible = shuffled(candidates.filter(member => {
                if (!sharedScene?.participantIds.includes(member.avatar)) return true;
                if (member.avatar === sharedScene.leadAvatar) return true;
                // 같은 자리에 있으면서도 모두가 게시하지는 않는다.
                return Math.random() * 100 < followupChance;
            }));
            const intervalMinutes = Math.max(60, Number(room.schedule?.cutIntervalHours || 2) * 60);
            const spreadMinutes = Math.min(55, Math.max(18, intervalMinutes * 0.55));
            const runTimes = spreadTimes(slotAt, eligible.length, spreadMinutes);
            for (const [index, member] of eligible.entries()) {
                db.jobs.push({
                    id: uid('job'), type: 'cut', roomId: room.id, charId: member.avatar, slotAt,
                    sharedSceneId: sharedScene?.participantIds.includes(member.avatar)
                        ? sharedScene.id
                        : null,
                    attempts: 0,
                    runAt: runTimes[index],
                });
            }
            room.nextSlotAt = computeNextSlot(room, slotAt);
        }

        const due = db.jobs.filter(j => j.runAt <= now);
        if (due.length) {
            db.jobs = db.jobs.filter(j => j.runAt > now);
            for (const job of due) {
                try { await executeJob(job, true); }
                catch (e) { console.error('[chatlog] 작업 실패:', job.type, e.message); }
            }
        }
        // 자동 정리는 하루 한 번만
        if (now - lastCleanup > 6 * 3600 * 1000) {
            lastCleanup = now;
            runCleanup();
        }

        saveDb();
    } finally {
        ticking = false;
    }
}

// ── 진입점 ────────────────────────────────────────────────
async function init(router) {
    loadAll();

    // SillyTavern의 로그인·CSRF 보호에 더해, 브라우저에서 다른 출처가
    // 챗로그 관리 API를 호출하는 요청을 한 번 더 거부한다.
    router.use((req, res, next) => {
        if (!requestMatchesServerOrigin(req)) {
            return res.status(403).json({ error: 'cross-origin request denied' });
        }
        if (req.method !== 'GET'
            && req.method !== 'HEAD'
            && !req.is?.('application/json')) {
            return res.status(415).json({ error: 'application/json 요청만 허용됩니다' });
        }
        next();
    });
    router.use(enforceRequestBudget);

    router.get('/state', (req, res) => res.json({ rooms: db.rooms, posts: db.posts }));
    router.get('/status', (req, res) => res.json(statusPayload()));

    router.get('/settings', (req, res) => {
        res.json({ ...settings, imageApiKey: settings.imageApiKey ? '••••' : '' });
    });

    router.post('/settings', (req, res) => {
        const body = req.body || {};
        if (body.userHandle !== undefined) {
            const requestedHandle = String(body.userHandle || '').trim();
            if (!requestedHandle || ai.safeUserHandle(requestedHandle) !== requestedHandle) {
                return res.status(400).json({ error: 'invalid userHandle' });
            }
        }
        for (const key of ['profileName', 'imageProfileName']) {
            const profileName = String(body[key] || '').trim();
            if (profileName.length > 200 || profileName.includes('\0')) {
                return res.status(400).json({ error: `invalid ${key}` });
            }
            if (!profileName) continue;
            const profile = ai.resolveProfileApi(settings, profileName, key === 'imageProfileName' ? 'image' : 'text');
            if (!profile || profile.source !== 'vertexai') {
                return res.status(400).json({
                    error: `${key === 'imageProfileName' ? '이미지' : '텍스트'} 연결은 Vertex AI 프로필만 사용할 수 있습니다`,
                });
            }
        }
        if (body.imageModel !== undefined) {
            const imageModel = String(body.imageModel || '').trim();
            if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(imageModel)
                || /-preview(?:-|$)/i.test(imageModel)) {
                return res.status(400).json({ error: 'invalid image model' });
            }
        }
        const numericRanges = {
            selfiePhotoChance: [0, 100],
            partnerSelfieChance: [0, 100],
            roomMeetupChance: [0, 100],
            sharedScenePostChance: [0, 100],
            characterCommentChance: [0, 100],
            commentDelayMinMin: [0, 600],
            commentDelayMaxMin: [1, 600],
            cleanupAfterDays: [0, 30],
        };
        for (const [key, [min, max]] of Object.entries(numericRanges)) {
            if (body[key] === undefined) continue;
            const value = Number(body[key]);
            if (!Number.isFinite(value) || value < min || value > max) {
                return res.status(400).json({ error: `invalid ${key}` });
            }
        }
        for (const key of ['followActiveProfile', 'autoCleanup', 'keepSaved', 'debugEnabled']) {
            if (body[key] !== undefined && typeof body[key] !== 'boolean') {
                return res.status(400).json({ error: `invalid ${key}` });
            }
        }
        if (body.userPersonaName !== undefined
            && String(body.userPersonaName).length > 120) {
            return res.status(400).json({ error: 'invalid userPersonaName' });
        }
        for (const k of Object.keys(settings)) {
            if (body[k] === undefined) continue;
            // 구버전 직접 입력 인증값은 더 이상 API로 변경하지 않는다.
            if (['imageApiKey', 'imageProjectId', 'imageRegion'].includes(k)) continue;
            if (k === 'userHandle') {
                settings[k] = String(body[k]).trim();
                continue;
            }
            if (k === 'textMode') {
                settings[k] = 'profile';
                continue;
            }
            if (k === 'imageProvider') {
                settings[k] = 'vertex';
                continue;
            }
            settings[k] = Object.prototype.hasOwnProperty.call(numericRanges, k)
                ? Number(body[k])
                : body[k];
        }
        saveSettings();
        ai.setDebugEnabled(settings.debugEnabled === true);
        res.json({ ok: true });
    });

    router.post('/room', (req, res) => {
        const {
            name,
            members = [],
            schedule = {},
            persona = null,
            memberPersonas = {},
        } = req.body || {};
        if (typeof name !== 'string' || !name.trim() || name.length > 100) {
            return res.status(400).json({ error: 'invalid room name' });
        }
        let normalizedMembers;
        let normalizedPersona;
        let normalizedMemberPersonas;
        let normalizedSchedule;
        try {
            normalizedMembers = normalizeMembersInput(members);
            normalizedPersona = normalizePersonaInput(persona);
            normalizedMemberPersonas = normalizeMemberPersonasInput(
                memberPersonas,
                normalizedMembers,
            );
            normalizedSchedule = normalizeScheduleInput(schedule);
        } catch (error) {
            return res.status(400).json({ error: sanitizeRuntimeError(error.message) || 'invalid room' });
        }
        const room = {
            id: uid('room'),
            name: name.trim(),
            members: normalizedMembers,
            persona: normalizedPersona,
            memberPersonas: normalizedMemberPersonas,
            createdAt: Date.now(), paused: false,
            slotHistory: [],
            sharedScenes: [],
            relationshipGraph: {
                version: 2,
                status: 'ready',
                generatedAt: null,
                displayPersona: normalizedPersona
                    ? { name: normalizedPersona.name || '유저', avatar: normalizedPersona.avatar || null }
                    : null,
                memberRelations: [],
                characterRelations: [],
                summary: '',
                lastError: null,
            },
            schedule: normalizedSchedule,
        };
        room.nextSlotAt = computeNextSlot(room);
        db.rooms[room.id] = room;
        db.posts[room.id] = [];
        saveDb();
        res.json(room);
    });

    router.post('/room/update', (req, res) => {
        const { roomId, ...patch } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });
        const allowedKeys = new Set([
            'name',
            'members',
            'persona',
            'memberPersonas',
            'schedule',
            'paused',
        ]);
        const rejectedKey = Object.keys(patch).find(key => !allowedKeys.has(key));
        if (rejectedKey) {
            return res.status(400).json({ error: `room field not allowed: ${rejectedKey}` });
        }
        if (patch.name !== undefined
            && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 100)) {
            return res.status(400).json({ error: 'invalid room name' });
        }
        if (patch.paused !== undefined && typeof patch.paused !== 'boolean') {
            return res.status(400).json({ error: 'invalid paused value' });
        }
        if (patch.name !== undefined) patch.name = patch.name.trim();
        try {
            if (patch.members !== undefined) patch.members = normalizeMembersInput(patch.members);
            const membersForPersonas = patch.members || room.members || [];
            if (patch.persona !== undefined) patch.persona = normalizePersonaInput(patch.persona);
            if (patch.memberPersonas !== undefined) {
                patch.memberPersonas = normalizeMemberPersonasInput(
                    patch.memberPersonas,
                    membersForPersonas,
                );
            } else if (patch.members !== undefined) {
                const knownMemberIds = new Set(membersForPersonas.map(member => member.avatar));
                const retainedPersonas = Object.fromEntries(
                    Object.entries(room.memberPersonas || {})
                        .filter(([memberId]) => knownMemberIds.has(memberId)),
                );
                patch.memberPersonas = normalizeMemberPersonasInput(
                    retainedPersonas,
                    membersForPersonas,
                );
            }
            if (patch.schedule !== undefined) {
                patch.schedule = normalizeScheduleInput(patch.schedule, room.schedule || {});
            }
        } catch (error) {
            return res.status(400).json({ error: sanitizeRuntimeError(error.message) || 'invalid room update' });
        }
        const personaBefore = JSON.stringify(room.persona || null);
        const identityBefore = JSON.stringify({
            persona: room.persona || null,
            memberPersonas: room.memberPersonas || {},
            members: (room.members || []).map(member => ({
                avatar: member.avatar,
                name: member.name,
                description: member.description || '',
                personality: member.personality || '',
                scenario: member.scenario || '',
                mesExample: member.mesExample || '',
            })),
        });
        Object.assign(room, patch);
        const identityAfter = JSON.stringify({
            persona: room.persona || null,
            memberPersonas: room.memberPersonas || {},
            members: (room.members || []).map(member => ({
                avatar: member.avatar,
                name: member.name,
                description: member.description || '',
                personality: member.personality || '',
                scenario: member.scenario || '',
                mesExample: member.mesExample || '',
            })),
        });
        if (identityBefore !== identityAfter) {
            const personaChanged = personaBefore !== JSON.stringify(room.persona || null);
            const hasManualRelations = (room.relationshipGraph?.memberRelations || [])
                .some(item => item?.locked === true || item?.confidence === 'manual');
            room.relationshipGraph = {
                ...(room.relationshipGraph || {}),
                version: 2,
                status: hasManualRelations && !personaChanged ? 'ready' : 'stale',
                displayPersona: room.persona
                    ? { name: room.persona.name || '유저', avatar: room.persona.avatar || null }
                    : null,
                lastError: null,
            };
        }
        if (patch.schedule) room.nextSlotAt = computeNextSlot(room);
        saveDb();
        res.json(room);
    });

    router.post('/room/relationships/manual', (req, res) => {
        const { roomId, memberRelations = [], characterRelations } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });
        const previous = room.relationshipGraph || {};
        let normalizedMemberRelations;
        let normalizedCharacterRelations;
        try {
            normalizedMemberRelations = normalizeManualRelations(
                room,
                memberRelations,
                'memberRelations',
            );
            normalizedCharacterRelations = characterRelations === undefined
                ? previous.characterRelations || []
                : normalizeManualRelations(room, characterRelations, 'characterRelations');
        } catch (error) {
            return res.status(400).json({ error: sanitizeRuntimeError(error.message) || 'invalid relationships' });
        }
        room.relationshipGraph = ai.normalizeRelationshipGraph(room, {
            memberRelations: normalizedMemberRelations,
            characterRelations: normalizedCharacterRelations,
        });
        room.relationshipGraph.version = 2;
        room.relationshipGraph.source = 'manual';
        room.relationshipGraph.status = 'ready';
        room.relationshipGraph.generatedAt = Date.now();
        saveDb();
        res.json({ ok: true, room, relationshipGraph: room.relationshipGraph });
    });

    router.post('/room/relationships/refresh', async (req, res) => {
        const { roomId } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });
        if (room.relationshipGraph?.status === 'building') {
            return res.status(409).json({ error: '이미 관계를 분석하고 있어요.' });
        }
        const guard = acquireProtectedAction(`relationships:${roomId}`, RELATIONSHIP_COOLDOWN_MS);
        if (!guard.ok) return rejectProtectedAction(res, guard, '관계 분석');

        room.relationshipGraph = {
            ...(room.relationshipGraph || {}),
            version: 2,
            status: 'building',
            displayPersona: room.persona
                ? { name: room.persona.name || '유저', avatar: room.persona.avatar || null }
                : null,
            lastError: null,
        };
        saveDb();

        try {
            room.relationshipGraph = await ai.analyzeRoomRelationships(settings, room);
            saveDb();
            res.json({ ok: true, room, relationshipGraph: room.relationshipGraph });
        } catch (error) {
            room.relationshipGraph = {
                ...(room.relationshipGraph || {}),
                version: 2,
                status: 'error',
                generatedAt: null,
                lastError: sanitizeRuntimeError(error?.message || error),
            };
            saveDb();
            console.error('[chatlog] 단톡 관계 분석 실패:', error);
            res.status(500).json({
                error: `관계 분석 실패: ${sanitizeRuntimeError(error.message) || 'AI 요청 실패'}`,
            });
        } finally {
            guard.release();
        }
    });

    router.post('/image/upload', (req, res) => {
        try {
            const imagePath = saveManualImage(req.body?.image, req.body?.mime);
            res.json({ ok: true, path: imagePath });
        } catch (error) {
            console.warn('[chatlog] 수동 이미지 업로드 거부:', error.message);
            res.status(error.statusCode || 400).json({
                error: sanitizeRuntimeError(error.message) || '이미지 업로드 실패',
            });
        }
    });

    router.post('/post', (req, res) => {
        const { roomId, text = '', image = null } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });
        // 다른 입력 경로처럼 문자열만 받고 길이를 제한한다.
        // 제한이 없으면 data.json과 AI 프롬프트가 무한히 커진다.
        if (typeof text !== 'string') {
            return res.status(400).json({ error: 'invalid post text' });
        }
        const safeText = text.slice(0, 500);

        // 이미지 경로 검증 — chatlog 이미지 폴더 내부 경로만 허용 (../ 탈출 차단)
        let safeImage = null;
        if (image !== null && image !== undefined && typeof image !== 'string') {
            return res.status(400).json({ error: 'invalid image path' });
        }
        if (image && typeof image === 'string') {
            const abs = resolveChatlogImage(image, true);
            if (abs) safeImage = image;
            else return res.status(400).json({ error: 'invalid image path' });
        }

        const post = {
            id: uid('post'), roomId, author: 'user',
            authorName: room.persona?.name || settings.userPersonaName || null,
            slotAt: Date.now(), createdAt: Date.now(),
            text: safeText, image: safeImage, imageSource: 'upload',
            sceneId: null, sceneContext: null,
            presenceKnown: false, presentPeople: [], visiblePeople: [],
            read: true, comments: [], reactions: [],
        };
        (db.posts[roomId] ??= []).push(post);
        enqueueEngagement(room, post);
        saveDb();
        res.json(post);
    });

    router.post('/read', (req, res) => {
        const { roomId } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        for (const p of db.posts[roomId] || []) {
            p.read = true;
            p.comments.forEach(c => { c.read = true; });
        }
        saveDb();
        res.json({ ok: true });
    });

    // 최근 AI 응답 원문은 사용자가 명시적으로 디버그 모드를 켠 경우에만 공개한다.
    router.get('/debug', (req, res) => {
        if (settings.debugEnabled !== true) {
            return res.status(403).json({ error: '디버그 모드가 꺼져 있습니다' });
        }
        res.json(ai.getDebug());
    });

    // 핫 리로드 — ai.js 와 settings.json 을 다시 읽는다 (서버 재시작 불필요)
    router.post('/reload', (req, res) => {
        const guard = acquireProtectedAction('reload', RELOAD_COOLDOWN_MS);
        if (!guard.ok) return rejectProtectedAction(res, guard, '리로드');
        try {
            reloadAi();
            settings = { ...settings, ...loadJson(SETTINGS_PATH, {}) };
            secureSettingsUserHandle();
            ai.setDebugEnabled(settings.debugEnabled === true);
            console.log('[chatlog] 리로드 완료');
            res.json({ ok: true, reloaded: ['ai.js', 'settings.json'] });
        } catch (e) {
            console.error('[chatlog] 리로드 실패:', e.message);
            res.status(500).json({
                ok: false,
                error: sanitizeRuntimeError(e.message) || '리로드 실패',
            });
        } finally {
            guard.release();
        }
    });

    // 클라이언트가 대기 댓글 작업을 가져감 (가져가면 큐에서 제거)
    router.post('/jobs/claim', (req, res) => {
        const { roomId, type = 'comment' } = req.body || {};
        if (!validOptionalRoomId(roomId)) {
            return res.status(400).json({ error: 'invalid room id' });
        }
        // 임의 type을 허용하면 유효한 작업을 큐에서 통째로 빼돌릴 수 있다.
        if (!VALID_JOB_TYPES.has(type)) {
            return res.status(400).json({ error: 'invalid job type' });
        }
        const claimed = db.jobs.filter(j => j.type === type && (!roomId || j.roomId === roomId));
        db.jobs = db.jobs.filter(j => !claimed.includes(j));
        saveDb();

        res.json(claimed.map(j => {
            const room = db.rooms[j.roomId];
            const member = room?.members.find(m => m.avatar === j.charId);
            const post = j.postId ? findPost(j.roomId, j.postId) : null;
            return {
                ...j,
                member,
                post,
                roomName: room?.name,
                recentComments: recentRoomCommentTexts(j.roomId, j.postId),
            };
        }));
    });

    router.post('/jobs/requeue', (req, res) => {
        const source = req.body?.job;
        if (!isPlainRecord(source)) {
            return res.status(400).json({ error: 'invalid job' });
        }
        if (!source.roomId || !source.charId || !source.type) {
            return res.status(400).json({ error: 'invalid job' });
        }
        if (!validRecordId(source.roomId, 'room') || !VALID_JOB_TYPES.has(source.type)) {
            return res.status(400).json({ error: 'invalid job' });
        }
        if (source.postId !== undefined
            && source.postId !== null
            && !validRecordId(source.postId, 'post')) {
            return res.status(400).json({ error: 'invalid job' });
        }
        const room = db.rooms[source.roomId];
        if (!room) {
            return res.status(404).json({ error: 'room not found' });
        }
        const member = room.members?.find(candidate => candidate.avatar === source.charId);
        if (!member) return res.status(400).json({ error: 'unknown job character' });
        if (source.id !== undefined && !validRecordId(source.id, 'job')) {
            return res.status(400).json({ error: 'invalid job id' });
        }
        if (source.id && db.jobs.some(candidate => candidate.id === source.id)) {
            return res.status(409).json({ error: 'job already queued' });
        }
        const needsPost = source.type !== 'cut';
        const post = source.postId ? findPost(source.roomId, source.postId) : null;
        if (needsPost && !post) return res.status(400).json({ error: 'job post not found' });
        if (!needsPost && source.postId) return res.status(400).json({ error: 'cut job cannot target post' });
        if (source.replyToCommentId !== undefined
            && source.replyToCommentId !== null
            && (!validRecordId(source.replyToCommentId, 'c')
                || !post?.comments?.some(comment => comment.id === source.replyToCommentId))) {
            return res.status(400).json({ error: 'reply target not found' });
        }
        if (source.commentIntent !== undefined
            && source.commentIntent !== null
            && !COMMENT_INTENTS.includes(source.commentIntent)) {
            return res.status(400).json({ error: 'invalid comment intent' });
        }
        if (source.commentWanted !== undefined && typeof source.commentWanted !== 'boolean') {
            return res.status(400).json({ error: 'invalid commentWanted' });
        }
        if (source.forcePost !== undefined && typeof source.forcePost !== 'boolean') {
            return res.status(400).json({ error: 'invalid forcePost' });
        }
        if (source.sharedSceneId !== undefined
            && source.sharedSceneId !== null
            && (!validRecordId(source.sharedSceneId, 'scene')
                || !findSharedScene(room, source.sharedSceneId))) {
            return res.status(400).json({ error: 'shared scene not found' });
        }
        if (source.slotAt !== undefined
            && source.slotAt !== null
            && (!Number.isFinite(Number(source.slotAt))
                || Math.abs(Number(source.slotAt) - Date.now()) > 31 * 24 * 3600 * 1000)) {
            return res.status(400).json({ error: 'invalid slotAt' });
        }
        const sourceAttempts = Number(source.attempts || 0);
        if (!Number.isInteger(sourceAttempts) || sourceAttempts < 0) {
            return res.status(400).json({ error: 'invalid attempts' });
        }
        const attempts = sourceAttempts + 1;
        if (attempts >= RETRY_DELAYS_MS.length + 1) {
            return res.status(400).json({ error: 'retry limit reached' });
        }
        const retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        const job = {
            id: source.id || uid('job'),
            type: source.type,
            roomId: source.roomId,
            postId: needsPost ? post.id : undefined,
            charId: member.avatar,
            replyToCommentId: source.replyToCommentId || undefined,
            commentWanted: source.commentWanted === true,
            commentIntent: source.commentIntent || undefined,
            slotAt: source.slotAt === undefined ? undefined : Number(source.slotAt),
            forcePost: source.forcePost === true,
            sharedSceneId: source.sharedSceneId || null,
            attempts,
            runAt: retryAt,
        };
        db.jobs.push(job);
        markJobError(
            job,
            new Error(sanitizeRuntimeError(req.body?.error) || '브라우저 작업 실패'),
            retryAt,
        );
        saveDb();
        res.json({ ok: true, retryAt, attempts });
    });

    // 클라이언트가 생성한 댓글을 되돌려 넣음
    router.post('/comment/push', (req, res) => {
        // charName은 더 이상 클라이언트 값을 신뢰하지 않고 서버 멤버 목록에서 가져온다.
        const { roomId, postId, charId, text } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        const post = findPost(roomId, postId);
        if (!post) return res.status(404).json({ error: 'post not found' });
        if (typeof text !== 'string') {
            return res.status(400).json({ error: 'invalid generated comment' });
        }
        const safeText = text.trim().slice(0, 120);
        if (!safeText || exposesInternalRoleLabel(safeText)) {
            return res.status(400).json({ error: 'invalid generated comment' });
        }
        if (ai.repeatsExistingComment(
            safeText,
            post.comments || [],
            recentRoomCommentTexts(roomId, postId),
        )) {
            return res.status(409).json({ error: 'generated comment is too similar to recent comments' });
        }
        const room = db.rooms[roomId];
        const member = room?.members?.find(candidate => candidate.avatar === charId);
        if (!room || !member || ai.violatesPresenceClaim(safeText, post, member)) {
            return res.status(409).json({ error: 'generated comment conflicts with photo participants' });
        }
        post.comments.push({
            id: uid('c'), author: member.avatar, authorName: member.name,
            text: safeText, createdAt: Date.now(), read: false,
        });
        saveDb();
        res.json({ ok: true });
    });

    // 이미지 생성 테스트
    router.post('/test/image', async (req, res) => {
        const guard = acquireProtectedAction('test-image', TEST_IMAGE_COOLDOWN_MS);
        if (!guard.ok) return rejectProtectedAction(res, guard, '이미지 테스트');
        try {
            if (req.body?.prompt !== undefined
                && (typeof req.body.prompt !== 'string' || req.body.prompt.length > 1000)) {
                return res.status(400).json({ ok: false, error: 'invalid image prompt' });
            }
            const p = await ai.generateImage(
                settings,
                req.body?.prompt || 'a cozy desk with a warm lamp at night, seen from first person',
                [],
                null,
                null,
                '',
                '',
                '',
                'everyday',
            );
            res.json({ ok: true, path: p });
        } catch (e) {
            console.error('[chatlog] 이미지 테스트 실패:', e);
            res.status(500).json({
                ok: false,
                error: sanitizeRuntimeError(e.message) || '이미지 생성 실패',
            });
        } finally {
            guard.release();
        }
    });

    // 유저 답글 — 캐릭터 게시물이면 그 캐릭터의 대댓글을 예약
    router.post('/comment/user', (req, res) => {
        const { roomId, postId, text } = req.body || {};
        if (!validRecordId(roomId, 'room')) return res.status(400).json({ error: 'invalid room id' });
        const room = db.rooms[roomId];
        const post = findPost(roomId, postId);
        if (!room || !post) return res.status(404).json({ error: 'post not found' });
        if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
            return res.status(400).json({ error: 'empty' });
        }

        const userComment = {
            id: uid('c'), author: 'user', authorName: room.persona?.name || settings.userPersonaName || null,
            text: text.trim().slice(0, 200), createdAt: Date.now(), read: true,
        };
        post.comments.push(userComment);

        if (post.author !== 'user') {
            const minMs = settings.commentDelayMinMin * 60000;
            const maxMs = settings.commentDelayMaxMin * 60000;
            db.jobs.push({
                id: uid('job'), type: 'comment',
                roomId, postId, charId: post.author,
                replyToCommentId: userComment.id,
                commentIntent: 'callback',
                attempts: 0,
                runAt: Date.now() + rand(minMs, maxMs),
            });
        }
        saveDb();
        res.json({ ok: true });
    });

    // 유저 이모지 반응 토글
    router.post('/react', (req, res) => {
        const { roomId, postId, emoji } = req.body || {};
        const post = findPost(roomId, postId);
        if (!post) return res.status(404).json({ error: 'post not found' });
        // emoji?.trim()은 null만 막고 숫자·객체는 TypeError로 500을 낸다.
        if (typeof emoji !== 'string' || !emoji.trim()) {
            return res.status(400).json({ error: 'emoji is required' });
        }
        const safeEmoji = emoji.trim().slice(0, 16);
        post.reactions ??= [];
        const i = post.reactions.findIndex(r => r.author === 'user' && r.emoji === safeEmoji);
        if (i >= 0) post.reactions.splice(i, 1);
        else post.reactions.push({
            author: 'user',
            authorName: db.rooms[roomId]?.persona?.name || settings.userPersonaName || null,
            emoji: safeEmoji,
            createdAt: Date.now(),
        });
        saveDb();
        res.json({ ok: true, reactions: post.reactions });
    });

    // 저장 표시 토글 (자동 정리에서 제외)
    router.post('/save', (req, res) => {
        const { roomId, postId, saved = true } = req.body || {};
        const post = findPost(roomId, postId);
        if (!post) return res.status(404).json({ error: 'post not found' });
        if (typeof saved !== 'boolean') {
            return res.status(400).json({ error: 'invalid saved value' });
        }
        post.saved = saved;
        saveDb();
        res.json({ ok: true, saved: post.saved });
    });

    // 게시물 삭제
    router.post('/delete', (req, res) => {
        const { roomId, postId } = req.body || {};
        if (!validRecordId(roomId, 'room') || !validRecordId(postId, 'post')) {
            return res.status(400).json({ error: 'invalid room or post id' });
        }
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });
        const list = db.posts[roomId];
        if (!Array.isArray(list)) return res.status(404).json({ error: 'post not found' });
        const i = list.findIndex(post => post.id === postId && post.roomId === roomId);
        if (i < 0) return res.status(404).json({ error: 'post not found' });
        if (list[i].image && !resolveChatlogImage(list[i].image, true)) {
            return res.status(409).json({ error: '게시물 이미지 경로 검증에 실패해 삭제를 중단했습니다' });
        }
        removeImageFile(list[i].image);
        list.splice(i, 1);
        db.jobs = db.jobs.filter(job => !(job.roomId === roomId && job.postId === postId));
        saveDb();
        res.json({ ok: true });
    });

    // 수동 정리
    router.post('/cleanup', (req, res) => {
        const guard = acquireProtectedAction('cleanup', CLEANUP_COOLDOWN_MS);
        if (!guard.ok) return rejectProtectedAction(res, guard, '수동 정리');
        const force = req.body?.force;
        const prev = settings.autoCleanup;
        try {
            if (force) settings.autoCleanup = true;
            runCleanup();
            settings.autoCleanup = prev;
            res.json({ ok: true });
        } finally {
            settings.autoCleanup = prev;
            guard.release();
        }
    });

    // ── 강제 실행 ─────────────────────────────────────────
    // what: 'comments' | 'reactions' | 'cut' | 'all'
    router.post('/force', async (req, res) => {
        const { roomId, what = 'all' } = req.body || {};
        const allowedActions = new Set(['comments', 'reactions', 'cut', 'all']);
        if (!allowedActions.has(what)) {
            return res.status(400).json({ error: 'invalid force action' });
        }
        // 검증이 없으면 "__proto__"·"constructor" 같은 값이 db.rooms 조회를 통과해
        // Object.prototype을 방 객체로 오인하고, 이후 room.members 접근에서
        // async 핸들러가 처리되지 않은 예외로 프로세스를 내릴 수 있다.
        if (!validOptionalRoomId(roomId)) {
            return res.status(400).json({ error: 'invalid room id' });
        }
        const rooms = roomId
            ? [Object.prototype.hasOwnProperty.call(db.rooms, roomId) ? db.rooms[roomId] : null]
                .filter(Boolean)
            : Object.values(db.rooms);
        if (!rooms.length) return res.status(404).json({ error: 'room not found' });
        const guard = acquireProtectedAction('force', FORCE_COOLDOWN_MS);
        if (!guard.ok) return rejectProtectedAction(res, guard, '강제 실행');

        const done = { comments: 0, reactions: 0, cuts: 0, skipped: 0, errors: [] };

        try {
            for (const room of rooms) {
            // 1. 대기 중인 댓글 작업 즉시 실행
            if (what === 'all' || what === 'comments') {
                const pending = db.jobs.filter(job => job.roomId === room.id
                    && Number(job.attempts || 0) === 0
                    && (job.type === 'comment'
                        || (job.type === 'engagement' && job.commentWanted === true)));
                db.jobs = db.jobs.filter(job => !pending.includes(job));
                for (const job of pending) {
                    try {
                        const result = await executeJob(job, true);
                        if (result?.status !== 'retrying') {
                            if (job.type === 'engagement') {
                                done.comments += result?.commented ? 1 : 0;
                                done.reactions += result?.reacted ? 1 : 0;
                            } else {
                                done.comments++;
                            }
                        }
                    }
                    catch (e) {
                        console.error('[chatlog] 강제 댓글 실패:', e);
                        done.errors.push(`comment: ${sanitizeRuntimeError(e.message) || '실패'}`);
                    }
                }
            }

            // 2. 캐릭터 컷 지금 바로 생성 (스케줄 무시)
            if (what === 'all' || what === 'cut') {
                const slotAt = Date.now();
                recordSlot(room, slotAt);
                const sharedScene = createSharedScenePlan(room, slotAt, room.members);
                for (const member of room.members) {
                    try {
                        const result = await executeJob({
                            id: uid('job'),
                            type: 'cut',
                            roomId: room.id,
                            charId: member.avatar,
                            slotAt,
                            forcePost: true,
                            sharedSceneId: sharedScene?.participantIds.includes(member.avatar)
                                ? sharedScene.id
                                : null,
                            attempts: 0,
                        }, true);
                        if (result?.status === 'posted') done.cuts++;
                        else if (result?.status !== 'retrying') done.skipped++;
                    } catch (e) {
                        console.error('[chatlog] 강제 게시 실패:', member.name, e);
                        done.errors.push(
                            `cut(${cleanDisplayName(member.name)}): ${sanitizeRuntimeError(e.message) || '실패'}`,
                        );
                    }
                }
            }

            // 3. 대기 중인 캐릭터 반응 즉시 실행
            // all에서는 바로 위에서 새로 만든 컷의 반응 작업도 함께 처리한다.
            if (what === 'all' || what === 'reactions') {
                const pending = db.jobs.filter(job => job.roomId === room.id
                    && Number(job.attempts || 0) === 0
                    && (job.type === 'reaction' || job.type === 'engagement'));
                db.jobs = db.jobs.filter(job => !pending.includes(job));
                for (const job of pending) {
                    try {
                        const result = await executeJob(job, true);
                        if (result?.status !== 'retrying') {
                            done.reactions += result?.reacted ? 1 : 0;
                            done.comments += result?.commented ? 1 : 0;
                        }
                    }
                    catch (e) {
                        console.error('[chatlog] 강제 반응 실패:', e);
                        done.errors.push(`reaction: ${sanitizeRuntimeError(e.message) || '실패'}`);
                    }
                }
            }
            }

            saveDb();
            res.json(done);
        } catch (error) {
            // Express는 async 핸들러의 거부를 잡아주지 않는다.
            // 여기서 삼키지 않으면 Node 기본 설정에서 프로세스가 종료된다.
            console.error('[chatlog] 강제 실행 실패:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    ...done,
                    error: sanitizeRuntimeError(error.message),
                });
            }
        } finally {
            guard.release();
        }
    });

    // 다음 슬롯 시각을 지금으로 당기기 (생성은 다음 틱에)
    router.post('/force/now', (req, res) => {
        const { roomId } = req.body || {};
        // 검증이 없으면 r.nextSlotAt 대입이 Object.prototype을 오염시킨다.
        if (!validOptionalRoomId(roomId)) {
            return res.status(400).json({ error: 'invalid room id' });
        }
        const rooms = roomId
            ? [Object.prototype.hasOwnProperty.call(db.rooms, roomId) ? db.rooms[roomId] : null]
                .filter(Boolean)
            : Object.values(db.rooms);
        if (!rooms.length) return res.status(404).json({ error: 'room not found' });
        const guard = acquireProtectedAction('force-now', FORCE_COOLDOWN_MS);
        if (!guard.ok) return rejectProtectedAction(res, guard, '다음 슬롯 즉시 실행');
        try {
            rooms.forEach(r => { r.nextSlotAt = Date.now(); });
            saveDb();
            res.json({ ok: true, rooms: rooms.length });
        } finally {
            guard.release();
        }
    });

    // 대기 중인 작업 확인
    router.get('/jobs', (req, res) => {
        res.json(db.jobs.map(j => ({
            type: j.type, roomId: j.roomId, charId: j.charId,
            sharedSceneId: j.sharedSceneId || null,
            attempts: Number(j.attempts || 0),
            lastError: j.lastError || null,
            runAt: new Date(j.runAt).toLocaleString('ko-KR'),
            inMinutes: Math.round((j.runAt - Date.now()) / 60000),
        })));
    });

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_MS);
    tick();
    console.log('[chatlog] 플러그인 시작됨');
}

module.exports = {
    init,
    exit: () => {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
        protectedActions.clear();
        requestBuckets.clear();
        try { flushDbSave(); }
        catch (error) { console.error('[chatlog] 종료 저장 실패:', error.message); }
    },
    info: { id: 'chatlog', name: 'Chatlog', description: '시간 슬롯 기반 로그 + 캐릭터 지연 댓글' },
};
