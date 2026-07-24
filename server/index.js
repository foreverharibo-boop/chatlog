/**
 * 챗로그 ST 서버 플러그인
 * 배치: SillyTavern/plugins/chatlog/index.js
 */

const fs = require('fs');
const path = require('path');

const ai = require('./ai');

const DATA_PATH = path.join(__dirname, 'data.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const TICK_MS = 60 * 1000;

// ST 루트 (plugins/chatlog 에서 두 단계 위)
const ST_ROOT = path.resolve(__dirname, '..', '..');

// ── 저장소 ────────────────────────────────────────────────
let db = { rooms: {}, posts: {}, jobs: [] };

let settings = {
    profileName: '',        // ST 연결 프로필 이름 (텍스트 생성용)
    userHandle: 'default-user',
    imageApiKey: '',        // 이미지 생성 키만 별도
    imageProvider: 'vertex',                     // 'vertex' (Express) | 'aistudio'
    imageModel: 'gemini-3.1-flash-lite-image',   // 나노바나나 2 Lite
    imageProjectId: '',                          // Vertex 프로젝트 ID
    imageRegion: 'global',                       // Vertex 리전
    userPersonaName: '',    // 유저 페르소나 이름 (클라이언트가 동기화)
    commentDelayMinMin: 1,
    commentDelayMaxMin: 30,
    autoCleanup: false,       // 지난 날 이미지/게시물 자동 삭제
    cleanupAfterDays: 1,      // 며칠 지난 것부터 지울지
    keepSaved: true,          // 저장 표시한 건 남기기
};

function loadJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

function loadAll() {
    db = loadJson(DATA_PATH, db);
    db.rooms ??= {}; db.posts ??= {}; db.jobs ??= [];
    settings = { ...settings, ...loadJson(SETTINGS_PATH, {}) };
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

// ── 작업 큐 ───────────────────────────────────────────────
function enqueueComments(room, post) {
    const minMs = settings.commentDelayMinMin * 60000;
    const maxMs = settings.commentDelayMaxMin * 60000;
    for (const member of room.members) {
        if (member.avatar === post.author) continue;
        db.jobs.push({
            id: uid('job'), type: 'comment',
            roomId: room.id, postId: post.id, charId: member.avatar,
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
        post.comments.push({
            id: uid('c'),
            author: member.avatar,
            authorName: member.name,
            text: await ai.generateComment(settings, room, post, member),
            createdAt: Date.now(), read: false,
        });
    }

    if (job.type === 'cut') {
        const member = findMember(room, job.charId);
        if (!member) return;
        const { text, image } = await ai.generateCharacterCut(settings, room, member, job.slotAt);
        (db.posts[room.id] ??= []).push({
            id: uid('post'), roomId: room.id, author: job.charId,
            slotAt: job.slotAt, createdAt: Date.now(),
            text, image, imageSource: 'generated',
            read: false, comments: [],
        });
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

    // 하루로그 내보내기 파일도 같이 정리
    const exportDir = path.join(ST_ROOT, 'public', 'user', 'images', 'chatlog', 'daylog');
    try {
        for (const f of fs.readdirSync(exportDir)) {
            const fp = path.join(exportDir, f);
            if (fs.statSync(fp).mtimeMs < cutoffTs) { fs.unlinkSync(fp); removed++; }
        }
    } catch { /* 폴더 없으면 무시 */ }

    if (removed) {
        console.log(`[chatlog] 자동 정리: ${removed}건 삭제`);
        saveDb();
    }
}

// ── 매분 틱 ───────────────────────────────────────────────
let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    const now = Date.now();

    try {
        for (const room of Object.values(db.rooms)) {
            if (room.paused) continue;
            if (!room.nextSlotAt) { room.nextSlotAt = computeNextSlot(room); continue; }
            if (room.nextSlotAt > now) continue;

            const slotAt = room.nextSlotAt;
            for (const member of room.members) {
                db.jobs.push({
                    id: uid('job'), type: 'cut', roomId: room.id, charId: member.avatar, slotAt,
                    runAt: slotAt + rand(0, 10 * 60 * 1000), // 동시에 우르르 올리지 않게 분산
                });
            }
            room.nextSlotAt = computeNextSlot(room, slotAt);
        }

        const due = db.jobs.filter(j => j.runAt <= now);
        if (due.length) {
            db.jobs = db.jobs.filter(j => j.runAt > now);
            for (const job of due) {
                try { await runJob(job); }
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
        const { name, members = [], schedule = {} } = req.body || {};
        const room = {
            id: uid('room'), name, members, createdAt: Date.now(), paused: false,
            schedule: {
                activeFrom: schedule.activeFrom ?? 8,
                activeTo: schedule.activeTo ?? 24,
                cutIntervalHours: schedule.cutIntervalHours ?? 2,
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
            slotAt: Date.now(), createdAt: Date.now(),
            text, image, imageSource: 'upload',
            read: true, comments: [],
        };
        (db.posts[roomId] ??= []).push(post);
        enqueueComments(room, post);
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
    // what: 'comments' | 'cut' | 'all'
    router.post('/force', async (req, res) => {
        const { roomId, what = 'all' } = req.body || {};
        const rooms = roomId ? [db.rooms[roomId]].filter(Boolean) : Object.values(db.rooms);
        if (!rooms.length) return res.status(404).json({ error: 'room not found' });

        const done = { comments: 0, cuts: 0, errors: [] };

        for (const room of rooms) {
            // 1. 대기 중인 댓글 작업 즉시 실행
            if (what === 'all' || what === 'comments') {
                const pending = db.jobs.filter(j => j.roomId === room.id && j.type === 'comment');
                db.jobs = db.jobs.filter(j => !(j.roomId === room.id && j.type === 'comment'));
                for (const job of pending) {
                    try { await runJob(job); done.comments++; }
                    catch (e) { done.errors.push(`comment: ${e.message}`); }
                }
            }

            // 2. 캐릭터 컷 지금 바로 생성 (스케줄 무시)
            if (what === 'all' || what === 'cut') {
                for (const member of room.members) {
                    try {
                        await runJob({ type: 'cut', roomId: room.id, charId: member.avatar, slotAt: Date.now() });
                        done.cuts++;
                    } catch (e) { done.errors.push(`cut(${member.name}): ${e.message}`); }
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
