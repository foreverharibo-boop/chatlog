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
        throw new Error(`${cfg.provider === 'vertex' ? 'vertex' : 'google'} ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
}

// ── 프로바이더별 호출 ─────────────────────────────────────
async function callGemini(api, { system, user, image }) {
    const parts = [{ text: user }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });

    const json = await callGoogle(
        { provider: api.provider, model: api.model, apiKey: api.apiKey, projectId: api.projectId, region: api.region },
        {
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 1.0, maxOutputTokens: 200 },
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
    if (!api?.apiKey) throw new Error('API 키를 찾을 수 없음 (secrets.json 확인)');
    if (api.source === 'makersuite' || /gemini/i.test(api.model || '')) {
        return callGemini(api, payload);
    }
    return callOpenAiCompatible(api, payload);
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

function othersBlock(post, member) {
    if (!post.comments?.length) return '';
    const lines = post.comments
        .filter(c => c.author !== member.avatar)
        .map(c => `${c.authorName || c.author}: ${c.text}`);
    if (!lines.length) return '';
    return `\n\n[이미 달린 댓글 — 겹치지 않게]\n${lines.join('\n')}`;
}

// ── 댓글 생성 ─────────────────────────────────────────────
async function generateComment(settings, room, post, member) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const system = [
        `너는 "${member.name}"이다. 아래 인물을 완전히 연기한다.`,
        '',
        charBlock(member),
        '',
        '지금 너는 "챗로그"라는 앱을 쓰고 있다. 친한 사람들끼리 하루 중 아무 순간이나 사진 한 장과 짧은 글로 올리는 앱이다.',
        `${settings.userPersonaName || '유저'}가 방금 게시물을 올렸고, 너는 거기에 댓글을 단다.`,
        '',
        '규칙:',
        '- 댓글은 1~2문장, 최대 40자 내외. 짧을수록 좋다.',
        '- SNS 댓글 말투. 완결된 문장이 아니어도 된다. 캐릭터 성격에 맞으면 이모티콘·ㅋㅋ·말줄임표 자유롭게.',
        '- 사진이 있으면 사진 속 구체적인 것 하나를 집어서 반응하라. 뭉뚱그리지 마라.',
        '- 나레이션, 행동 묘사(*...*), 따옴표 금지. 댓글 텍스트만 출력한다.',
        '- 이름표나 접두사를 붙이지 마라.',
    ].join('\n');

    const user = [
        `[${timeLabel(post.createdAt)}에 올라온 게시물]`,
        post.text ? `글: ${post.text}` : '(글 없음)',
        post.image ? '(사진 첨부됨)' : '(사진 없음)',
        othersBlock(post, member),
        '',
        '이 게시물에 달 댓글 하나만 출력하라.',
    ].join('\n');

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

// ── 캐릭터 컷 생성 ────────────────────────────────────────
async function generateCharacterCut(settings, room, member, slotAt) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const system = [
        `너는 "${member.name}"이다.`,
        '',
        charBlock(member),
        '',
        '너는 "챗로그" 앱에 지금 이 순간을 올리려고 한다.',
        '',
        'JSON만 출력한다. 마크다운 코드펜스 금지.',
        '{"caption": "올릴 글 (25자 이내, SNS 캡션 말투)", "scene": "지금 눈앞 장면을 영어로 묘사한 이미지 프롬프트"}',
        '',
        'scene 규칙: 1인칭 시점으로 눈앞에 보이는 것. 인물 얼굴은 넣지 않는다. 조명·장소·사물 위주로 구체적으로.',
    ].join('\n');

    const user = `지금은 ${timeLabel(slotAt)}이다. 이 시각에 너는 무엇을 하고 있나? JSON으로 답하라.`;

    const raw = await callText(api, { system, user });
    let parsed;
    try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
        parsed = { caption: raw.trim().slice(0, 40), scene: '' };
    }

    let image = null;
    if (parsed.scene && settings.imageApiKey) {
        try { image = await generateImage(settings, parsed.scene); }
        catch (e) { console.error('[chatlog] 이미지 생성 실패:', e.message); }
    }

    return { text: parsed.caption || '', image };
}

// ── 이미지 생성 ───────────────────────────────────────────
async function generateImage(settings, scene) {
    const prompt = `${scene}. Casual amateur phone snapshot, natural available light, slightly imperfect framing, no text, no watermark.`;

    if (!settings.imageApiKey) throw new Error('이미지 API 키가 비어 있습니다');

    const json = await callGoogle({
        provider: settings.imageProvider === 'vertex' ? 'vertex' : 'aistudio',
        model: settings.imageModel,
        apiKey: settings.imageApiKey,
        projectId: settings.imageProjectId,
        region: settings.imageRegion,
    }, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
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

module.exports = { resolveTextApi, googleUrl, callGoogle, generateComment, generateCharacterCut, generateImage, timeLabel };
