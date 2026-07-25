/**
 * 챗로그 ST 서버 플러그인
 * 배치: SillyTavern/plugins/chatlog/index.js
 */

const fs = require('fs');
const path = require('path');

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

// ST 루트 (plugins/chatlog 에서 두 단계 위)
const ST_ROOT = path.resolve(__dirname, '..', '..');

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
    followActiveProfile: true, // 클라이언트가 ST의 현재 연결 프로필을 자동 동기화
    userHandle: 'default-user',
    imageApiKey: '',        // 이미지 생성 키만 별도
    textMode: 'express',                         // 'express' = 이미지와 같은 키로 텍스트도 생성 | 'profile' = ST 연결 프로필
    textModel: 'gemini-2.5-flash',               // express 모드에서 쓸 텍스트 모델
    imageProvider: 'vertex',                     // 'vertex' (Express) | 'aistudio'
    imageModel: 'gemini-3.1-flash-lite-image',   // 나노바나나 2 Lite
    imageProjectId: '',                          // 구버전 설정 호환용 (Express에서는 사용 안 함)
    imageRegion: 'global',                       // 구버전 설정 호환용 (Express에서는 사용 안 함)
    userPersonaName: '',    // 유저 페르소나 이름 (클라이언트가 동기화)
    commentDelayMinMin: 1,
    commentDelayMaxMin: 30,
    characterCommentChance: 30, // 다른 캐릭터 게시물에 댓글도 남길 확률
    autoCleanup: false,       // 지난 날 이미지/게시물 자동 삭제
    cleanupAfterDays: 1,      // 며칠 지난 것부터 지울지
    keepSaved: true,          // 저장 표시한 건 남기기
};

function loadJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

function cleanDisplayName(value) {
    let name = String(value || '').trim();
    try { name = decodeURIComponent(name); } catch { /* 이미 일반 문자열 */ }
    name = path.basename(name).replace(/\.(png|jpe?g|webp|gif|avif)$/i, '').trim();
    return name || '캐릭터';
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

    for (const room of Object.values(db.rooms)) {
        room.slotHistory ??= [];
        room.memberPersonas ??= {};
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
function saveDb() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2)); }
        catch (e) { console.error('[chatlog] 저장 실패:', e.message); }
    }, 300);
}

function saveSettings() {
    try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); }
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
    db.runtime.lastError = `${jobLabel(job).replace(/ 완료$/, '')}: ${error.message}`
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
const rand = (min, max) => min + Math.random() * (max - min);

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
    for (const member of room.members) {
        if (member.avatar === post.author) continue;
        const commentWanted = post.author === 'user'
            || Math.random() * 100 < Math.max(0, Math.min(100, settings.characterCommentChance));
        db.jobs.push({
            id: uid('job'),
            type: 'engagement',
            roomId: room.id,
            postId: post.id,
            charId: member.avatar,
            commentWanted,
            attempts: 0,
            runAt: Date.now() + rand(minMs, maxMs),
        });
    }
    saveDb();
}

const findPost = (roomId, postId) => (db.posts[roomId] || []).find(p => p.id === postId);
const findMember = (room, avatar) => room.members.find(m => m.avatar === avatar);

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
        });
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
        const previous = (db.posts[room.id] || [])
            .filter(post => post.author === member.avatar)
            .sort((a, b) => (b.slotAt ?? b.createdAt) - (a.slotAt ?? a.createdAt))[0];
        const lastPostAt = previous?.slotAt ?? previous?.createdAt ?? room.createdAt;
        const maxSilenceHours = Math.max(
            room.schedule?.cutIntervalHours ?? 2,
            room.schedule?.maxSilenceHours ?? 12,
        );
        const forcePost = !!job.forcePost
            || activeHoursBetween(lastPostAt, job.slotAt, room.schedule) >= maxSilenceHours;
        const result = await ai.generateCharacterCut(settings, room, member, job.slotAt, {
            forcePost,
            randomRoll: Math.floor(rand(0, 100)),
            activeHoursSinceLastPost: activeHoursBetween(lastPostAt, job.slotAt, room.schedule),
            maxSilenceHours,
        });
        if (result.skipped) return { status: 'skipped' };
        const { text, image } = result;
        const post = {
            id: uid('post'), roomId: room.id, author: job.charId,
            authorName: member.name,
            slotAt: job.slotAt, createdAt: Date.now(),
            text, image, imageSource: 'generated',
            read: false, comments: [], reactions: [],
        };
        (db.posts[room.id] ??= []).push(post);
        enqueueEngagement(room, post);
        return { status: 'posted', post };
    }
}

function retryableJobError(error) {
    const message = String(error?.message || '');
    if (/(?:400|401|403|invalid api|api 키|연결 프로필을 찾을 수 없음|프로젝트 ID)/i.test(message)) {
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
                lastError: error.message,
                runAt: retryAt,
            });
            markJobError(job, error, retryAt);
            console.warn(`[chatlog] 작업 재시도 예약 (${attempts}/3):`, job.type, error.message);
            return { status: 'retrying', retryAt, error: error.message };
        }
        markJobError(job, error);
        throw error;
    }
}

// ── 자동 정리 ─────────────────────────────────────────────
function removeImageFile(webPath) {
    if (!webPath || !webPath.includes('/chatlog/')) return;
    try {
        fs.unlinkSync(path.join(ST_ROOT, 'public', webPath.replace(/^\/+/, '')));
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
    }

    // 하루로그 내보내기 파일도 같이 정리
    const exportDir = path.join(ST_ROOT, 'public', 'user', 'images', 'chatlog', 'daylog');
    try {
        for (const f of fs.readdirSync(exportDir)) {
            const fp = path.join(exportDir, f);
            if (fs.statSync(fp).mtimeMs < cutoffTs) { fs.unlinkSync(fp); removed++; }
        }
    } catch { /* 폴더 없으면 무시 */ }

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
                db.jobs.push({
                    id: uid('job'),
                    type: 'cut',
                    roomId: room.id,
                    charId: member.avatar,
                    slotAt: now,
                    runAt: now + rand(0, 2 * 60 * 1000),
                    forcePost: true,
                    attempts: 0,
                    resumedAfterGap: true,
                });
            }
        }
    }
    if (overdueMembers.length) recordSlot(room, now);
    room.nextSlotAt = computeNextSlot(room, now);
    db.runtime.lastNoticeAt = now;
    db.runtime.lastNotice = `${room.name}: 밀린 슬롯 건너뜀`
        + (overdueMembers.length ? ` · 최대 공백 ${overdueMembers.length}명 현재 시각 재개` : '');
}

// ── 매분 틱 ───────────────────────────────────────────────
let ticking = false;
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
            for (const member of room.members) {
                db.jobs.push({
                    id: uid('job'), type: 'cut', roomId: room.id, charId: member.avatar, slotAt,
                    attempts: 0,
                    runAt: slotAt + rand(0, 10 * 60 * 1000), // 동시에 우르르 올리지 않게 분산
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

    router.get('/state', (req, res) => res.json({ rooms: db.rooms, posts: db.posts }));
    router.get('/status', (req, res) => res.json(statusPayload()));

    router.get('/settings', (req, res) => {
        res.json({ ...settings, imageApiKey: settings.imageApiKey ? '••••' : '' });
    });

    router.post('/settings', (req, res) => {
        const body = req.body || {};
        for (const k of Object.keys(settings)) {
            if (body[k] === undefined) continue;
            if (k === 'imageApiKey' && body[k] === '••••') continue; // 마스킹된 값은 무시
            settings[k] = body[k];
        }
        saveSettings();
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
        const normalizedMembers = members.map(member => ({
            ...member,
            name: cleanDisplayName(member.name || member.avatar),
        }));
        const room = {
            id: uid('room'), name, members: normalizedMembers, persona, memberPersonas,
            createdAt: Date.now(), paused: false,
            slotHistory: [],
            schedule: {
                activeFrom: schedule.activeFrom ?? 8,
                activeTo: schedule.activeTo ?? 24,
                cutIntervalHours: schedule.cutIntervalHours ?? 2,
                maxSilenceHours: schedule.maxSilenceHours ?? 12,
                jitter: schedule.jitter ?? true,
            },
        };
        room.nextSlotAt = computeNextSlot(room);
        db.rooms[room.id] = room;
        db.posts[room.id] = [];
        saveDb();
        res.json(room);
    });

    router.post('/room/update', (req, res) => {
        const { roomId, ...patch } = req.body || {};
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });
        if (patch.members) {
            patch.members = patch.members.map(member => ({
                ...member,
                name: cleanDisplayName(member.name || member.avatar),
            }));
        }
        Object.assign(room, patch);
        if (patch.schedule) room.nextSlotAt = computeNextSlot(room);
        saveDb();
        res.json(room);
    });

    router.post('/post', (req, res) => {
        const { roomId, text = '', image = null } = req.body || {};
        const room = db.rooms[roomId];
        if (!room) return res.status(404).json({ error: 'room not found' });

        const post = {
            id: uid('post'), roomId, author: 'user',
            authorName: room.persona?.name || settings.userPersonaName || null,
            slotAt: Date.now(), createdAt: Date.now(),
            text, image, imageSource: 'upload',
            read: true, comments: [], reactions: [],
        };
        (db.posts[roomId] ??= []).push(post);
        enqueueEngagement(room, post);
        saveDb();
        res.json(post);
    });

    router.post('/read', (req, res) => {
        const { roomId } = req.body || {};
        for (const p of db.posts[roomId] || []) {
            p.read = true;
            p.comments.forEach(c => { c.read = true; });
        }
        saveDb();
        res.json({ ok: true });
    });

    // 최근 AI 응답 원문 (디버그)
    router.get('/debug', (req, res) => res.json(ai.getDebug()));

    // 핫 리로드 — ai.js 와 settings.json 을 다시 읽는다 (서버 재시작 불필요)
    router.post('/reload', (req, res) => {
        try {
            reloadAi();
            settings = { ...settings, ...loadJson(SETTINGS_PATH, {}) };
            console.log('[chatlog] 리로드 완료');
            res.json({ ok: true, reloaded: ['ai.js', 'settings.json'] });
        } catch (e) {
            console.error('[chatlog] 리로드 실패:', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 클라이언트가 대기 댓글 작업을 가져감 (가져가면 큐에서 제거)
    router.post('/jobs/claim', (req, res) => {
        const { roomId, type = 'comment' } = req.body || {};
        const claimed = db.jobs.filter(j => j.type === type && (!roomId || j.roomId === roomId));
        db.jobs = db.jobs.filter(j => !claimed.includes(j));
        saveDb();

        res.json(claimed.map(j => {
            const room = db.rooms[j.roomId];
            const member = room?.members.find(m => m.avatar === j.charId);
            const post = j.postId ? findPost(j.roomId, j.postId) : null;
            return { ...j, member, post, roomName: room?.name };
        }));
    });

    router.post('/jobs/requeue', (req, res) => {
        const source = req.body?.job || {};
        if (!source.roomId || !source.charId || !source.type) {
            return res.status(400).json({ error: 'invalid job' });
        }
        const attempts = Number(source.attempts || 0) + 1;
        if (attempts >= RETRY_DELAYS_MS.length + 1) {
            return res.status(400).json({ error: 'retry limit reached' });
        }
        const retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        const job = {
            id: source.id || uid('job'),
            type: source.type,
            roomId: source.roomId,
            postId: source.postId,
            charId: source.charId,
            replyToCommentId: source.replyToCommentId,
            commentWanted: source.commentWanted,
            slotAt: source.slotAt,
            forcePost: source.forcePost,
            attempts,
            runAt: retryAt,
        };
        db.jobs.push(job);
        markJobError(job, new Error(req.body?.error || '브라우저 작업 실패'), retryAt);
        saveDb();
        res.json({ ok: true, retryAt, attempts });
    });

    // 클라이언트가 생성한 댓글을 되돌려 넣음
    router.post('/comment/push', (req, res) => {
        const { roomId, postId, charId, charName, text } = req.body || {};
        const post = findPost(roomId, postId);
        if (!post) return res.status(404).json({ error: 'post not found' });
        post.comments.push({
            id: uid('c'), author: charId, authorName: charName,
            text, createdAt: Date.now(), read: false,
        });
        saveDb();
        res.json({ ok: true });
    });

    // 이미지 생성 테스트
    router.post('/test/image', async (req, res) => {
        try {
            const p = await ai.generateImage(settings, req.body?.prompt
                || 'a cozy desk with a warm lamp at night, seen from first person');
            res.json({ ok: true, path: p });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 유저 답글 — 캐릭터 게시물이면 그 캐릭터의 대댓글을 예약
    router.post('/comment/user', (req, res) => {
        const { roomId, postId, text } = req.body || {};
        const room = db.rooms[roomId];
        const post = findPost(roomId, postId);
        if (!room || !post) return res.status(404).json({ error: 'post not found' });
        if (!text?.trim()) return res.status(400).json({ error: 'empty' });

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
        if (!emoji?.trim()) return res.status(400).json({ error: 'emoji is required' });
        post.reactions ??= [];
        const i = post.reactions.findIndex(r => r.author === 'user' && r.emoji === emoji);
        if (i >= 0) post.reactions.splice(i, 1);
        else post.reactions.push({
            author: 'user',
            authorName: db.rooms[roomId]?.persona?.name || settings.userPersonaName || null,
            emoji: emoji.trim().slice(0, 16),
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
        post.saved = !!saved;
        saveDb();
        res.json({ ok: true, saved: post.saved });
    });

    // 게시물 삭제
    router.post('/delete', (req, res) => {
        const { roomId, postId } = req.body || {};
        const list = db.posts[roomId] || [];
        const i = list.findIndex(p => p.id === postId);
        if (i < 0) return res.status(404).json({ error: 'post not found' });
        removeImageFile(list[i].image);
        list.splice(i, 1);
        saveDb();
        res.json({ ok: true });
    });

    // 수동 정리
    router.post('/cleanup', (req, res) => {
        const force = req.body?.force;
        const prev = settings.autoCleanup;
        if (force) settings.autoCleanup = true;
        runCleanup();
        settings.autoCleanup = prev;
        res.json({ ok: true });
    });

    // ── 강제 실행 ─────────────────────────────────────────
    // what: 'comments' | 'reactions' | 'cut' | 'all'
    router.post('/force', async (req, res) => {
        const { roomId, what = 'all' } = req.body || {};
        const rooms = roomId ? [db.rooms[roomId]].filter(Boolean) : Object.values(db.rooms);
        if (!rooms.length) return res.status(404).json({ error: 'room not found' });

        const done = { comments: 0, reactions: 0, cuts: 0, skipped: 0, errors: [] };

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
                    catch (e) { done.errors.push(`comment: ${e.message}`); }
                }
            }

            // 2. 캐릭터 컷 지금 바로 생성 (스케줄 무시)
            if (what === 'all' || what === 'cut') {
                const slotAt = Date.now();
                recordSlot(room, slotAt);
                for (const member of room.members) {
                    try {
                        const result = await executeJob({
                            id: uid('job'),
                            type: 'cut',
                            roomId: room.id,
                            charId: member.avatar,
                            slotAt,
                            forcePost: true,
                            attempts: 0,
                        }, true);
                        if (result?.status === 'posted') done.cuts++;
                        else if (result?.status !== 'retrying') done.skipped++;
                    } catch (e) { done.errors.push(`cut(${member.name}): ${e.message}`); }
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
                    catch (e) { done.errors.push(`reaction: ${e.message}`); }
                }
            }
        }

        saveDb();
        res.json(done);
    });

    // 다음 슬롯 시각을 지금으로 당기기 (생성은 다음 틱에)
    router.post('/force/now', (req, res) => {
        const { roomId } = req.body || {};
        const rooms = roomId ? [db.rooms[roomId]].filter(Boolean) : Object.values(db.rooms);
        rooms.forEach(r => { r.nextSlotAt = Date.now(); });
        saveDb();
        res.json({ ok: true, rooms: rooms.length });
    });

    // 대기 중인 작업 확인
    router.get('/jobs', (req, res) => {
        res.json(db.jobs.map(j => ({
            type: j.type, roomId: j.roomId, charId: j.charId,
            attempts: Number(j.attempts || 0),
            lastError: j.lastError || null,
            runAt: new Date(j.runAt).toLocaleString('ko-KR'),
            inMinutes: Math.round((j.runAt - Date.now()) / 60000),
        })));
    });

    setInterval(tick, TICK_MS);
    tick();
    console.log('[chatlog] 플러그인 시작됨');
}

module.exports = {
    init,
    exit: () => {},
    info: { id: 'chatlog', name: 'Chatlog', description: '시간 슬롯 기반 로그 + 캐릭터 지연 댓글' },
};
