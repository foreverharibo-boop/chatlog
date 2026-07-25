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

function imageMime(file) {
    const ext = path.extname(file || '').toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.avif') return 'image/avif';
    return 'image/png';
}

function readReferenceFile(candidates, label, filename) {
    for (const candidate of candidates) {
        try {
            const buf = fs.readFileSync(candidate);
            return { mime: imageMime(candidate), data: buf.toString('base64') };
        } catch { /* 다음 후보 */ }
    }
    console.warn(`[chatlog] ${label} 프사를 못 찾음:`, filename);
    return null;
}

// ── 프사 읽기 (이미지 속 인물 외모 일관성용 레퍼런스) ─────────
function readAvatar(settings, avatarFile) {
    if (!avatarFile) return null;
    const filename = path.basename(String(avatarFile));
    const userDir = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user');
    return readReferenceFile([
        path.join(userDir, 'characters', filename),
        path.join(ST_ROOT, 'public', 'characters', filename),
    ], '캐릭터', filename);
}

function readPersonaAvatar(settings, avatarFile) {
    if (!avatarFile) return null;
    const filename = path.basename(String(avatarFile));
    const userDir = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user');
    return readReferenceFile([
        path.join(userDir, 'User Avatars', filename),
        path.join(ST_ROOT, 'public', 'User Avatars', filename),
    ], '페르소나', filename);
}

// ── 최근 대화 읽기 ────────────────────────────────────────
/**
 * data/<user>/chats/<캐릭터명>/ 안에서 가장 최근 .jsonl 을 열어 마지막 N개 발화를 뽑는다.
 * 컷 생성에서는 말투와 유저와의 관계만 참고한다. 대화 속 유저의 행동을 캐릭터의
 * 실제 일상으로 오인하지 않도록 발화 주체를 명시한다.
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
                const speaker = o.is_user === true
                    ? '유저'
                    : o.name === charName
                        ? `캐릭터(${charName})`
                        : `다른 인물(${o.name || '알 수 없음'})`;
                msgs.push(`${speaker}: ${String(o.mes).replace(/\s+/g, ' ').slice(0, 200)}`);
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

function seasonContext(ts) {
    const d = new Date(ts);
    const month = d.getMonth() + 1;
    const [seasonKo, seasonEn] = month === 12 || month <= 2
        ? ['겨울', 'winter']
        : month <= 5
            ? ['봄', 'spring']
            : month <= 8
                ? ['여름', 'summer']
                : ['가을', 'autumn'];
    return {
        year: d.getFullYear(),
        month,
        day: d.getDate(),
        hour: d.getHours(),
        seasonKo,
        seasonEn,
        label: `${d.getFullYear()}년 ${month}월 ${d.getDate()}일 ${seasonKo}`,
    };
}

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

function relationshipPersona(settings, room, member) {
    return room?.memberPersonas?.[member?.avatar]
        || room?.persona
        || {
            name: settings.userPersonaName || '유저',
            description: '',
            avatar: null,
        };
}

function postAuthorName(settings, room, post, member = null) {
    if (post.author === 'user') {
        return member
            ? relationshipPersona(settings, room, member).name
            : room?.persona?.name || settings.userPersonaName || '유저';
    }
    return post.authorName
        || room.members.find(m => m.avatar === post.author)?.name
        || post.author;
}

// ── 댓글 생성 ─────────────────────────────────────────────
async function generateComment(settings, room, post, member, options = {}) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const recent = readRecentChat(settings, member.name, 8);
    const persona = relationshipPersona(settings, room, member);
    const personaName = persona.name || '유저';
    const isOwnPost = post.author === member.avatar;
    const authorName = postAuthorName(settings, room, post, member);
    const targetUserComment = options.replyToCommentId
        ? (post.comments || []).find(c => c.id === options.replyToCommentId && c.author === 'user')
        : [...(post.comments || [])].reverse().find(c => c.author === 'user');
    const isReply = isOwnPost && !!targetUserComment;
    const task = isReply
        ? `네가 챗로그에 올린 게시물에 ${personaName}가 댓글을 달았다. 아래에 [반드시 답할 댓글]로 표시된 바로 그 댓글에 답댓글을 단다.`
        : `${authorName}가 챗로그에 올린 게시물에 댓글을 단다.`;

    const system = [
        `너는 "${member.name}"이다. 아래 인물을 완전히 연기한다.`,
        '',
        charBlock(member),
        persona.description
            ? `\n[이 캐릭터에게 연결된 유저 페르소나]\n이름: ${personaName}\n설명: ${persona.description}`
            : '',
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
            ? `[반드시 답할 댓글]\n${personaName}: ${targetUserComment.text}`
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
    const authorName = postAuthorName(settings, room, post, member);
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

    const recent = readRecentChat(settings, member.name, 8);
    const forcePost = !!decision.forcePost;
    const persona = relationshipPersona(settings, room, member);
    const personaName = persona.name || settings.userPersonaName || '유저';
    const personaDescription = persona.description || '';
    const temporal = seasonContext(slotAt);

    const system = [
        `너는 "${member.name}"이다.`,
        '',
        '[캐릭터 카드 — 일상·정체성 판단의 최우선 근거]',
        charBlock(member),
        personaDescription
            ? `\n[유저 페르소나 — "${member.name}"와는 별개의 인물]\n이름: ${personaName}\n설명: ${personaDescription}`
            : `\n[유저 페르소나 — "${member.name}"와는 별개의 인물]\n이름: ${personaName}`,
        recent ? `\n[최근 대화 발췌 — 현재 관계와 공유된 상황을 파악]\n${recent}` : '',
        '',
        '너는 "chatlog" 앱을 확인하고 있다. 이번 시간대에 게시물을 올릴지 먼저 결정한다.',
        '단체 로그의 모든 인물이 매번 올릴 필요는 없다. 캐릭터 카드의 성격과 일상에 따라 독립적으로 결정한다.',
        '',
        '정보 우선순위와 주체 구분:',
        '- 캐릭터 카드가 정체성, 성별, 외모, 직업, 성격, 생활 방식의 최우선 기준이다.',
        '- 최근 대화에서는 두 사람의 현재 관계, 호칭, 감정, 공유 중인 사건과 각자의 상황을 적극적으로 파악한다.',
        '- 최근 관계와 사건은 캐릭터의 일상 선택에 자연스럽게 영향을 줄 수 있다. 관계 맥락을 무조건 지우지 마라.',
        '- 단, "유저:"가 한 행동과 유저의 신체 상태·직업·일정은 유저의 것이다. 캐릭터 본인의 것으로 바꾸지 마라.',
        `- 유저 페르소나(${personaName})의 상황 때문에 캐릭터(${member.name})가 동행, 기다림, 준비, 걱정, 선물, 연락 등을 하는 장면은 가능하다. 각자의 역할만 정확히 유지한다.`,
        `- 예: 유저 페르소나(${personaName})가 임신 중이라면 캐릭터(${member.name})가 산모 교실에 데려다주거나 밖에서 기다리는 장면은 가능하지만, 캐릭터(${member.name}) 본인이 임신했거나 산모인 것처럼 묘사하면 안 된다.`,
        '- 캐릭터 카드에 없는 신체 상태·직업·가족관계를 캐릭터 본인에게 새로 부여하지 마라.',
        '',
        'JSON만 출력한다. 마크다운 코드펜스 금지.',
        '{"post": true 또는 false, "caption": "캐릭터 시점의 25자 이내 SNS 캡션", "scene": "사진 장면을 영어로 묘사", "visualIdentity": "게시 캐릭터의 눈에 보이는 외형만 영어 200자 이내", "personaVisible": true 또는 false, "personaVisualIdentity": "페르소나가 보일 때 페르소나의 눈에 보이는 외형만 영어 200자 이내", "roleCheck": "캐릭터와 유저가 각각 무엇을 하는지 짧게 확인"}',
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
        '- post가 true면 visualIdentity에는 캐릭터 카드에서 확인되는 성별, 대략적 나이, 머리, 얼굴, 체격, 현재 옷처럼 사진에 필요한 외형만 짧게 쓴다.',
        '- visualIdentity에 성격, 관계, 과거사, 직업 설명, 유저 정보, 신체 상태에 관한 추측을 넣지 마라.',
        `- 사진 안에 유저 페르소나(${personaName})가 실제로 보일 때만 personaVisible을 true로 한다.`,
        `- personaVisible이 true면 personaVisualIdentity에는 유저 페르소나 설명에서 확인되는 외형과 계절에 맞는 현재 옷차림만 쓴다. 캐릭터(${member.name})의 외형과 섞지 마라.`,
        '- personaVisible이 false면 personaVisualIdentity는 빈 문자열로 둔다.',
        '',
        'post가 true일 때 scene 규칙:',
        '- 캐릭터 카드에 적힌 직업, 취미, 성격, 생활 방식과 최근 관계 상황이 자연스럽게 함께 드러나는 일상을 만든다.',
        '- 최근 대화의 사건을 그대로 복사할 필요는 없지만, 지금 관계 때문에 캐릭터가 실제로 할 법한 선택과 행동은 반영한다.',
        '- 이 시각에 이 캐릭터가 실제로 있을 법한 곳, 실제로 보고 있을 법한 것.',
        `- scene은 사진을 올리는 사람이 "${member.name}"임을 전제로 쓴다. 인물이 나오면 이름 또는 "the male character", "his partner"처럼 역할을 명확히 적는다.`,
        '- 장면의 모든 행동·직업·신체 상태가 누구의 것인지 roleCheck로 마지막 검증한다. 서로 뒤바뀌었으면 고쳐서 출력한다.',
        '- caption도 캐릭터가 직접 쓴 말이어야 하며, 유저가 쓴 것처럼 시점을 바꾸지 마라.',
        '- 사진 구도는 반드시 둘 중 하나다: (1) 사람이 전혀 없는 캐릭터 시점의 풍경·음식·물건 사진, (2) 게시 캐릭터가 직접 찍은 셀카.',
        `- 사람이 한 명이라도 등장하면 게시 캐릭터(${member.name})도 반드시 프레임에 보이는 전면 카메라 셀카, 팔을 뻗은 셀카 또는 거울 셀카여야 한다.`,
        '- 다른 사람이 함께 나오면 게시 캐릭터와 같이 찍은 그룹 셀카로 묘사한다.',
        '- 제3자가 찍어준 사진, 멀리서 찍힌 전신 사진, 몰래 찍은 사진, 감시 카메라, 삼각대, 영화 스틸 같은 구도는 금지한다.',
        `- 사람이 나오는 scene에는 반드시 "front-facing smartphone selfie taken by ${member.name}" 또는 "mirror selfie taken by ${member.name}"라고 명시한다.`,
        '- 폰으로 방금 대충 찍어 바로 올린 스냅이어야 한다. 구도가 조금 어긋나도 좋다.',
        '- 조명·장소·사물을 구체적으로. 추상적 표현 금지.',
        `- 현재 달력은 ${temporal.label}이다. 장면의 옷차림, 자연광의 길이와 색, 식생과 주변 환경을 ${temporal.seasonKo}에 자연스럽게 맞춘다.`,
        '- 계절만 보고 비·눈·폭염 같은 정확한 날씨를 임의로 만들지는 마라.',
        '- 장면에 명시된 지역이 남반구·열대이거나 실내 환경이라면 그 지역과 장소의 조건을 계절 일반값보다 우선한다.',
    ].filter(Boolean).join('\n');

    const user = [
        `현재 날짜와 시각은 ${temporal.label}, ${timeLabel(slotAt)}이다.`,
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
            const references = [
                {
                    role: 'posting character',
                    name: member.name,
                    image: readAvatar(settings, member.avatar),
                },
            ];
            if (parsed.personaVisible === true || parsed.personaVisible === 'true') {
                references.push({
                    role: 'user persona',
                    name: personaName,
                    image: readPersonaAvatar(settings, persona.avatar),
                });
            }
            image = await generateImage(
                settings,
                parsed.scene,
                references,
                member,
                persona,
                parsed.visualIdentity,
                parsed.personaVisualIdentity,
                `${temporal.label} (${temporal.seasonEn}), ${timeLabel(slotAt)}`,
            );
        } catch (e) {
            console.error('[chatlog] 이미지 생성 실패:', e.message);
            throw e;
        }
    }

    if (!image) throw new Error('이미지를 만들지 못해 게시물을 저장하지 않음');
    return { skipped: false, text: (parsed.caption || '').slice(0, 60), image };
}

// ── 이미지 생성 ───────────────────────────────────────────
function findGeneratedImage(json) {
    for (const candidate of json?.candidates || []) {
        for (const part of candidate?.content?.parts || []) {
            const inline = part?.inline_data || part?.inlineData;
            if (inline?.data) return inline;
        }
    }
    return null;
}

function imageResponseSummary(json) {
    const reasons = (json?.candidates || []).map(c => c.finishReason).filter(Boolean);
    const text = (json?.candidates || [])
        .flatMap(c => c?.content?.parts || [])
        .map(part => part?.text)
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 180);
    return [reasons.length ? `finish=${reasons.join(',')}` : '', text]
        .filter(Boolean)
        .join(' · ') || '빈 응답';
}

function normalizeReferences(references) {
    const list = Array.isArray(references)
        ? references
        : references
            ? [references]
            : [];
    return list
        .map((reference, index) => reference?.image
            ? reference
            : {
                role: index === 0 ? 'posting character' : `person ${index + 1}`,
                name: '',
                image: reference,
            })
        .filter(reference => reference?.image?.data);
}

async function requestGeneratedImage(settings, prompt, references = []) {
    const parts = [{ text: prompt }];
    for (const [index, reference] of normalizeReferences(references).entries()) {
        parts.push({
            text: `Reference image ${index + 1}: ${reference.role || 'person'}${reference.name ? ` "${reference.name}"` : ''}. Keep this person distinct from every other reference.`,
        });
        parts.push({
            inline_data: {
                mime_type: reference.image.mime,
                data: reference.image.data,
            },
        });
    }
    return callGoogle({
        provider: settings.imageProvider === 'vertex' ? 'vertex' : 'aistudio',
        model: settings.imageModel,
        apiKey: settings.imageApiKey,
        projectId: settings.imageProjectId,
        region: settings.imageRegion,
    }, {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['Image'],
        },
    });
}

async function generateImage(
    settings,
    scene,
    references = [],
    member = null,
    persona = null,
    visualIdentity = '',
    personaVisualIdentity = '',
    temporalContext = '',
) {
    if (!settings.imageApiKey) throw new Error('이미지 API 키가 비어 있습니다');

    const usableReferences = normalizeReferences(references);
    const posterName = member?.name || 'the posting character';
    const visible = String(visualIdentity || '').trim().slice(0, 500);
    const personaVisible = String(personaVisualIdentity || '').trim().slice(0, 500);
    const identityRule = [
        `The person posting this photo is ${posterName}.`,
        visible ? `Visible identity of ${posterName}: ${visible}.` : '',
        'Preserve the posting character’s gender, age, face, hair and build.',
        persona?.name
            ? `${persona.name} is a separate person from the posting character; never merge their bodies, conditions or actions.`
            : '',
        personaVisible && persona?.name
            ? `Visible identity of user persona ${persona.name}: ${personaVisible}. Preserve their face, hair, age, build and clothing separately.`
            : '',
    ].filter(Boolean).join(' ');
    const cameraRule = 'If any person appears, make it a believable front-facing smartphone selfie, arm’s-length selfie, or mirror selfie taken by the posting character, who must be visible in frame. Multiple people must appear together in a group selfie. Never use a third-person, candid observer, tripod, surveillance, cinematic, or someone-else-took-it angle. If no person appears, use a first-person phone photo of scenery, food, or objects.';
    const seasonRule = temporalContext
        ? `Calendar context: ${temporalContext}. Match clothing, daylight, vegetation and surroundings to this date, season and time. Do not invent rain, snow or extreme weather from the season alone. If the described location has a different climate or the scene is indoors, follow the actual location and environment instead.`
        : '';
    const qualityRule = 'Create the image now as a casual phone snapshot taken moments ago for an immediate social post. Natural available light, slightly imperfect framing, no text, no watermark.';
    const fullPrompt = `${scene}. ${identityRule} ${seasonRule} ${cameraRule} ${qualityRule}`;
    const compactPrompt = `${scene}. ${identityRule} ${seasonRule} Generate a casual phone selfie if any person appears; otherwise generate a first-person phone snapshot. No text or watermark.`;
    const attempts = [
        { label: '인물 참조+전체 프롬프트', prompt: fullPrompt, references: usableReferences },
        { label: '인물 참조+간단 프롬프트', prompt: compactPrompt, references: usableReferences },
        ...(usableReferences.length
            ? [{ label: '텍스트 외형 폴백', prompt: compactPrompt, references: [] }]
            : []),
    ];

    let inline = null;
    const failures = [];
    for (const attempt of attempts) {
        try {
            const json = await requestGeneratedImage(settings, attempt.prompt, attempt.references);
            inline = findGeneratedImage(json);
            if (inline) break;
            const summary = imageResponseSummary(json);
            failures.push(`${attempt.label}: ${summary}`);
            console.warn(`[chatlog] 이미지 응답에 데이터 없음 (${attempt.label}):`, summary);
        } catch (e) {
            failures.push(`${attempt.label}: ${e.message}`);
            if (/(?:401|403|429|quota|billing|permission)/i.test(e.message)) throw e;
        }
    }
    if (!inline) throw new Error(`이미지 데이터 없음 — ${failures.join(' / ')}`);

    const dir = path.join(ST_ROOT, 'public', 'user', 'images', 'chatlog');
    fs.mkdirSync(dir, { recursive: true });
    const mime = inline.mime_type || inline.mimeType || 'image/png';
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const filename = `cut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), Buffer.from(inline.data, 'base64'));

    return `/user/images/chatlog/${filename}`;
}

module.exports = {
    resolveTextApi,
    googleUrl,
    callGoogle,
    readAvatar,
    readPersonaAvatar,
    readRecentChat,
    getDebug,
    generateComment,
    generateReaction,
    generateCharacterCut,
    generateImage,
    timeLabel,
    seasonContext,
};
