/**
 * 챗로그 — AI 호출 모듈
 * 서버에서 연결 프로필을 해석해 텍스트 생성, 이미지는 별도 키로 생성.
 */

const fs = require('fs');
const path = require('path');

const ST_ROOT = path.resolve(__dirname, '..', '..');

const loadJson = (p, fb) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; }
};

// ── 연결 프로필 해석 ──────────────────────────────────────
function resolveTextApi(settings) {
    // Express 모드 — 이미지와 동일한 키/프로젝트로 텍스트도 호출한다.
    // 정식 Vertex 프로필은 서비스 계정 OAuth가 필요해서 API 키로는 401이 난다.
    if (settings.textMode === 'express') {
        if (!settings.imageApiKey) return null;
        return {
            name: 'express',
            source: 'vertexai',
            model: settings.textModel || 'gemini-2.5-flash',
            apiKey: settings.imageApiKey,
            provider: settings.imageProvider === 'aistudio' ? 'aistudio' : 'vertex',
            projectId: settings.imageProjectId || '',
            region: settings.imageRegion || 'global',
        };
    }

    const userDir = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user');
    const stSettings = loadJson(path.join(userDir, 'settings.json'), {});
    const secrets = loadJson(path.join(userDir, 'secrets.json'), {});

    const profiles = stSettings?.extension_settings?.connectionManager?.profiles || [];
    const profile = profiles.find(p => p.name === settings.profileName) || profiles[0];
    if (!profile) return null;

    const source = profile['api-source'] || profile.api || 'openai';
    return {
        name: profile.name,
        source,
        model: profile.model,
        apiKey: secrets[`api_key_${source}`] || secrets[`api_key_vertexai`] || '',
        customUrl: profile['custom-url'] || profile.reverse_proxy || '',
        provider: source === 'vertexai' ? 'vertex' : 'aistudio',
        projectId: profile.vertexai_project || settings.imageProjectId || '',
        region: profile.vertexai_region || settings.imageRegion || 'global',
    };
}

// ── 캐릭터 프사 읽기 (폴라로이드 패턴: 외모 일관성용 레퍼런스) ──
function readAvatar(settings, avatarFile) {
    if (!avatarFile) return null;
    const userDir = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user');
    const candidates = [
        path.join(userDir, 'characters', avatarFile),
        path.join(ST_ROOT, 'public', 'characters', avatarFile),
    ];
    for (const p of candidates) {
        try {
            const buf = fs.readFileSync(p);
            return { mime: 'image/png', data: buf.toString('base64') };
        } catch { /* 다음 후보 */ }
    }
    console.warn('[chatlog] 프사를 못 찾음:', avatarFile);
    return null;
}

// ── 최근 대화 읽기 ────────────────────────────────────────
/**
 * data/<user>/chats/<캐릭터명>/ 안에서 가장 최근 .jsonl 을 열어 마지막 N개 발화를 뽑는다.
 * 캐릭터가 "요즘 뭐 하고 지내는지"를 컷에 반영하기 위한 것.
 */
function readRecentChat(settings, charName, limit = 12) {
    if (!charName) return '';
    const dir = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user', 'chats', charName);

    let files;
    try {
        files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
    } catch {
        return '';
    }
    if (!files.length) return '';

    try {
        const lines = fs.readFileSync(path.join(dir, files[0].f), 'utf-8')
            .split('\n')
            .filter(Boolean);

        const msgs = [];
        for (const line of lines) {
            try {
                const o = JSON.parse(line);
                if (!o.mes) continue;                 // 첫 줄은 메타데이터
                msgs.push(`${o.name}: ${String(o.mes).replace(/\s+/g, ' ').slice(0, 200)}`);
            } catch { /* 깨진 줄 무시 */ }
        }
        return msgs.slice(-limit).join('\n');
    } catch (e) {
        console.warn('[chatlog] 대화 읽기 실패:', e.message);
        return '';
    }
}

// ── 이미지 → base64 ───────────────────────────────────────
function readImageAsBase64(webPath) {
    if (!webPath) return null;
    try {
        const rel = webPath.replace(/^\/+/, '');
        const abs = path.join(ST_ROOT, 'public', rel);
        const buf = fs.readFileSync(abs);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
        return { mime, data: buf.toString('base64') };
    } catch {
        return null;
    }
}

// ── Google 엔드포인트 (AI Studio / Vertex Express 공용) ──
/**
 * 폴라로이드 프록시와 같은 방식. Vertex Express 모드는 서비스 계정 OAuth 없이
 * API 키를 x-goog-api-key 헤더로 그대로 넘긴다.
 */
function googleUrl({ provider, model, projectId, region }) {
    if (provider === 'vertex') {
        if (!projectId) throw new Error('Vertex 모드에는 프로젝트 ID가 필요합니다');
        const r = region || 'global';
        const base = r === 'global'
            ? 'https://aiplatform.googleapis.com/v1'
            : `https://${r}-aiplatform.googleapis.com/v1`;
        return `${base}/projects/${projectId}/locations/${r}/publishers/google/models/${model}:generateContent`;
    }
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

async function callGoogle(cfg, body) {
    const res = await fetch(googleUrl(cfg), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const detail = await res.text();
        console.error('[chatlog] Google API 오류', cfg.provider, cfg.model, res.status, detail);
        throw new Error(`${cfg.provider === 'vertex' ? 'vertex' : 'google'} ${res.status} (${cfg.model}): ${detail.slice(0, 600)}`);
    }
    return res.json();
}

// ── 프로바이더별 호출 ─────────────────────────────────────
const lastDebug = [];
function pushDebug(entry) {
    lastDebug.push({ time: new Date().toLocaleTimeString('ko-KR'), ...entry });
    if (lastDebug.length > 10) lastDebug.shift();
}
function getDebug() { return lastDebug; }

async function callGemini(api, { system, user, image, json: wantJson }) {
    const parts = [{ text: user }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });

    const generationConfig = { temperature: 1.0, maxOutputTokens: 2048 };
    if (wantJson) generationConfig.response_mime_type = 'application/json';
    // gemini-2.5 계열은 thinking이 기본 ON — 출력 토큰을 생각에 다 쓰고 빈 답을 주는 원인.
    if (/2\.5/.test(api.model || '')) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const json = await callGoogle(
        { provider: api.provider, model: api.model, apiKey: api.apiKey, projectId: api.projectId, region: api.region },
        {
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig,
        },
    );
    return json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

async function callOpenAiCompatible(api, { system, user, image }) {
    const content = [{ type: 'text', text: user }];
    if (image) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${image.mime};base64,${image.data}` },
        });
    }

    const base = api.customUrl || 'https://api.openai.com/v1';
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${api.apiKey}`,
        },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content },
            ],
            temperature: 1.0,
            max_tokens: 200,
        }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content || '';
}

async function callText(api, payload) {
    if (!api?.apiKey) throw new Error('API 키를 찾을 수 없음 (Express 키 또는 secrets.json 확인)');
    if (api.provider === 'vertex' || api.source === 'makersuite' || /gemini/i.test(api.model || '')) {
        return callGemini(api, payload);
    }
    return callOpenAiCompatible(api, payload);
}

// ── JSON 추출 (코드펜스/잡소리에 강함) ──────────────────────
function extractJson(raw) {
    if (!raw) return null;
    const text = String(raw).replace(/```[a-z]*\n?/gi, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

// ── 프롬프트 ──────────────────────────────────────────────
const timeLabel = (ts) => {
    const d = new Date(ts);
    const h = d.getHours();
    const ampm = h < 12 ? '오전' : '오후';
    return `${ampm} ${h % 12 || 12}시 ${String(d.getMinutes()).padStart(2, '0')}분`;
};

function charBlock(member) {
    return [
        `이름: ${member.name}`,
        member.description && `설명: ${member.description}`,
        member.personality && `성격: ${member.personality}`,
        member.scenario && `상황: ${member.scenario}`,
        member.mesExample && `말투 예시:\n${member.mesExample}`,
    ].filter(Boolean).join('\n');
}

function othersBlock(post, member, excludeCommentId = null) {
    if (!post.comments?.length) return '';
    const lines = post.comments
        .filter(c => c.author !== member.avatar && c.id !== excludeCommentId)
        .map(c => `${c.authorName || c.author}: ${c.text}`);
    if (!lines.length) return '';
    return `\n\n[이미 달린 댓글 — 겹치지 않게]\n${lines.join('\n')}`;
}

function postAuthorName(settings, room, post) {
    if (post.author === 'user') return settings.userPersonaName || '유저';
    return post.authorName
        || room.members.find(m => m.avatar === post.author)?.name
        || post.author;
}

// ── 댓글 생성 ─────────────────────────────────────────────
async function generateComment(settings, room, post, member, options = {}) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const recent = readRecentChat(settings, member.name, 8);
    const isOwnPost = post.author === member.avatar;
    const authorName = postAuthorName(settings, room, post);
    const targetUserComment = options.replyToCommentId
        ? (post.comments || []).find(c => c.id === options.replyToCommentId && c.author === 'user')
        : [...(post.comments || [])].reverse().find(c => c.author === 'user');
    const isReply = isOwnPost && !!targetUserComment;
    const task = isReply
        ? `네가 챗로그에 올린 게시물에 ${settings.userPersonaName || '유저'}가 댓글을 달았다. 아래에 [반드시 답할 댓글]로 표시된 바로 그 댓글에 답댓글을 단다.`
        : `${authorName}가 챗로그에 올린 게시물에 댓글을 단다.`;

    const system = [
        `너는 "${member.name}"이다. 아래 인물을 완전히 연기한다.`,
        '',
        charBlock(member),
        recent ? `\n[최근 대화 — 말투와 관계만 참고]\n${recent}` : '',
        '',
        '지금 너는 "챗로그"라는 앱을 쓰고 있다. 친한 사람들끼리 하루 중 아무 순간이나 사진 한 장과 짧은 글로 올리는 앱이다.',
        task,
        '',
        '규칙:',
        '- 댓글은 1~2문장, 최대 40자 내외. 짧을수록 좋다.',
        '- SNS 댓글 말투. 완결된 문장이 아니어도 된다. 캐릭터 성격에 맞으면 이모티콘·ㅋㅋ·말줄임표 자유롭게.',
        '- 사진이 있으면 사진 속 구체적인 것 하나를 집어서 반응하라. 뭉뚱그리지 마라.',
        '- 나레이션, 행동 묘사(*...*), 따옴표 금지. 댓글 텍스트만 출력한다.',
        '- 이름표나 접두사를 붙이지 마라.',
        '- 최근 대화의 분위기와 호칭을 유지하라.',
        isReply ? '- 답댓글은 [반드시 답할 댓글]의 내용에 직접 대답하라.' : '',
        isReply ? '- 유저 댓글과 무관한 새 화제를 꺼내거나, 사진 속 인물·옷의 소유자·사건을 추측하지 마라.' : '',
    ].filter(Boolean).join('\n');

    const user = [
        isReply
            ? `[반드시 답할 댓글]\n${settings.userPersonaName || '유저'}: ${targetUserComment.text}`
            : '',
        isReply ? '\n아래 게시물 정보는 위 댓글에 답하는 데 필요한 경우에만 참고한다.' : '',
        `[${timeLabel(post.createdAt)}에 올라온 게시물]`,
        post.text ? `글: ${post.text}` : '(글 없음)',
        post.image ? '(사진 첨부됨)' : '(사진 없음)',
        othersBlock(post, member, targetUserComment?.id),
        '',
        isReply
            ? '위 유저 댓글에 달 답댓글 하나만 출력하라.'
            : '이 게시물에 달 댓글 하나만 출력하라.',
    ].filter(Boolean).join('\n');

    const raw = await callText(api, {
        system,
        user,
        image: readImageAsBase64(post.image),
    });

    return raw
        .trim()
        .replace(/^["'「『]|["'」』]$/g, '')
        .replace(/^\*+|\*+$/g, '')
        .replace(/^[^:\n]{1,20}:\s*/, '')   // "이름: " 접두사 제거
        .split('\n')[0]
        .slice(0, 120)
        .trim();
}

// ── 캐릭터 이모지 반응 생성 ────────────────────────────────
const REACTION_EMOJIS = ['❤️', '😂', '🥹', '😮', '😢', '😡', '👏', '🔥', '👍', '👀'];

async function generateReaction(settings, room, post, member) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const recent = readRecentChat(settings, member.name, 5);
    const authorName = postAuthorName(settings, room, post);
    const system = [
        `너는 "${member.name}"이다. 아래 인물의 성격대로 반응한다.`,
        '',
        charBlock(member),
        recent ? `\n[최근 대화 분위기]\n${recent}` : '',
        '',
        `"${authorName}"의 챗로그 게시물에 이모지 반응 하나를 남긴다.`,
        `반드시 다음 중 딱 하나만 출력한다: ${REACTION_EMOJIS.join(' ')}`,
        '설명, 이름, 문장, 따옴표를 붙이지 마라.',
    ].filter(Boolean).join('\n');

    const user = [
        `[${timeLabel(post.createdAt)}에 올라온 게시물]`,
        post.text ? `글: ${post.text}` : '(글 없음)',
        post.image ? '(사진 첨부됨)' : '(사진 없음)',
        '',
        '이 게시물에 어울리고 네 성격에도 맞는 이모지 하나만 골라라.',
    ].join('\n');

    const raw = await callText(api, {
        system,
        user,
        image: readImageAsBase64(post.image),
    });
    return REACTION_EMOJIS.find(emoji => String(raw).includes(emoji)) || '👍';
}

// ── 캐릭터 컷 생성 ────────────────────────────────────────
async function generateCharacterCut(settings, room, member, slotAt, decision = {}) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const recent = readRecentChat(settings, member.name);
    const forcePost = !!decision.forcePost;

    const system = [
        `너는 "${member.name}"이다.`,
        '',
        charBlock(member),
        recent ? `\n[최근 대화 — 지금 이 인물이 처한 상황]\n${recent}` : '',
        '',
        '너는 "chatlog" 앱을 확인하고 있다. 이번 시간대에 게시물을 올릴지 먼저 결정한다.',
        '단체 로그의 모든 인물이 매번 올릴 필요는 없다. 성격, 현재 상황, 최근 대화에 따라 독립적으로 결정한다.',
        '',
        'JSON만 출력한다. 마크다운 코드펜스 금지.',
        '{"post": true 또는 false, "caption": "올릴 때만 25자 이내 SNS 캡션", "scene": "올릴 때만 사진 장면을 영어로 묘사"}',
        '',
        '게시 여부 규칙:',
        forcePost
            ? '- 최대 공백에 도달했으므로 이번에는 반드시 post를 true로 한다.'
            : '- 과시적·사교적·공유를 즐기는 성격은 자주, 과묵·사적·바쁜 성격은 드물게 올린다.',
        forcePost
            ? ''
            : '- 성격에 맞춰 게시 기준을 고른다: 공유를 매우 즐김 30, 보통 55, 과묵·내향적 75, 매우 사적·바쁨 85.',
        forcePost
            ? ''
            : '- 랜덤 게시 충동이 선택한 기준 이상일 때만 post를 true로 한다.',
        '- 지금 실제로 찍어 공유할 만한 순간이 없으면 post는 false다.',
        '- post가 false면 caption과 scene은 빈 문자열로 둔다.',
        '',
        'post가 true일 때 scene 규칙:',
        '- 최근 대화 상황과 이어지는 장면이어야 한다. 뜬금없는 장소 금지.',
        '- 이 시각에 이 인물이 실제로 있을 법한 곳, 실제로 보고 있을 법한 것.',
        '- 폰으로 대충 찍은 스냅. 구도가 조금 어긋나도 좋다.',
        '- 인물이 프레임에 들어와도 되고, 눈앞 풍경만 담아도 된다.',
        '- 조명·장소·사물을 구체적으로. 추상적 표현 금지.',
    ].filter(Boolean).join('\n');

    const user = [
        `지금은 ${timeLabel(slotAt)}이다.`,
        `이번 랜덤 게시 충동은 ${decision.randomRoll ?? 50}/99이다.`,
        `활동 시간 기준 마지막 게시 후 약 ${Number(decision.activeHoursSinceLastPost || 0).toFixed(1)}시간 지났다.`,
        forcePost
            ? '이번에는 반드시 올린다. 무엇을 찍어 올릴지 JSON으로 답하라.'
            : '이 시각에 정말 올릴지, 건너뛸지 캐릭터답게 결정해 JSON으로 답하라.',
    ].join('\n');

    const raw = await callText(api, { system, user, json: true });
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('게시 여부 JSON 파싱 실패');

    const shouldPost = forcePost || parsed.post === true || parsed.post === 'true';
    if (!shouldPost) {
        return { skipped: true, text: '', image: null };
    }
    if (!parsed.scene) {
        console.warn('[chatlog] scene 파싱 실패, 원문:', String(raw).slice(0, 200));
    }

    let image = null;
    if (parsed.scene && settings.imageApiKey) {
        try {
            image = await generateImage(settings, parsed.scene, readAvatar(settings, member.avatar));
        } catch (e) {
            console.error('[chatlog] 이미지 생성 실패:', e.message);
        }
    }

    return { skipped: false, text: (parsed.caption || '').slice(0, 60), image };
}

// ── 이미지 생성 ───────────────────────────────────────────
async function generateImage(settings, scene, reference = null) {
    let prompt = `${scene}. Casual amateur phone snapshot, natural available light, slightly imperfect framing, no text, no watermark.`;

    if (reference) {
        // 폴라로이드 패턴 — 프사를 외모 기준으로 고정
        prompt += ' If a person appears in the frame, their face, hairstyle, hair color and outfit must match the attached reference image exactly. Do not invent a different person.';
    }

    if (!settings.imageApiKey) throw new Error('이미지 API 키가 비어 있습니다');

    const parts = [{ text: prompt }];
    if (reference) parts.push({ inline_data: { mime_type: reference.mime, data: reference.data } });

    const json = await callGoogle({
        provider: settings.imageProvider === 'vertex' ? 'vertex' : 'aistudio',
        model: settings.imageModel,
        apiKey: settings.imageApiKey,
        projectId: settings.imageProjectId,
        region: settings.imageRegion,
    }, {
        contents: [{ role: 'user', parts }],
    });

    const part = json?.candidates?.[0]?.content?.parts?.find(p => p.inline_data || p.inlineData);
    const inline = part?.inline_data || part?.inlineData;
    if (!inline) throw new Error('이미지 데이터 없음');

    // ST public 아래에 직접 저장 (서버라 /api/images/upload 안 거쳐도 됨)
    const dir = path.join(ST_ROOT, 'public', 'user', 'images', 'chatlog');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `cut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;
    fs.writeFileSync(path.join(dir, filename), Buffer.from(inline.data, 'base64'));

    return `/user/images/chatlog/${filename}`;
}

module.exports = {
    resolveTextApi,
    googleUrl,
    callGoogle,
    readAvatar,
    readRecentChat,
    getDebug,
    generateComment,
    generateReaction,
    generateCharacterCut,
    generateImage,
    timeLabel,
};
