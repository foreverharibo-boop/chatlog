/**
 * 챗로그 — AI 호출 모듈
 * 서버에서 SillyTavern 연결 프로필을 해석해 텍스트와 이미지를 생성.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ST_ROOT = path.resolve(__dirname, '..', '..');

const loadJson = (p, fb) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; }
};

function secretValue(secrets, key, secretId = '', exactId = false) {
    const saved = secrets?.[key];
    if (Array.isArray(saved)) {
        const byId = secretId
            ? saved.find(item => String(item?.id) === String(secretId))
            : null;
        if (exactId) return byId?.value || '';
        const selected = byId
            || saved.find(item => item?.active)
            || saved[0];
        return selected?.value || '';
    }
    return typeof saved === 'string' ? saved : '';
}

function parseServiceAccount(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function vertexEndpointConfig(profile, oaiSettings) {
    const candidates = [
        profile?.['api-url'],
        profile?.['custom-url'],
        profile?.endpoint,
        oaiSettings?.vertexai_endpoint,
        oaiSettings?.vertexai_api_url,
    ].filter(Boolean).map(String);
    for (const value of candidates) {
        const match = value.match(/\/projects\/([^/]+)\/locations\/([^/]+)/i);
        if (match) {
            return {
                projectId: decodeURIComponent(match[1]),
                region: decodeURIComponent(match[2]),
            };
        }
    }
    return {};
}

// ── 연결 프로필 해석 ──────────────────────────────────────
function resolveProfileApi(settings, profileName, kind = 'text') {
    const userDir = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user');
    const stSettings = loadJson(path.join(userDir, 'settings.json'), {});
    const secrets = loadJson(path.join(userDir, 'secrets.json'), {});

    const profiles = stSettings?.extension_settings?.connectionManager?.profiles || [];
    const profile = profiles.find(p => p.name === profileName)
        || (!profileName && kind === 'image'
            ? profiles.find(p => (p?.['api-source'] || p?.api) === 'vertexai')
            : null);
    if (!profile) return null;

    const source = profile['api-source'] || profile.api || 'openai';
    const secretId = profile['secret-id'] || profile.secretId || '';
    const oaiSettings = stSettings?.oai_settings || stSettings?.openai_settings || {};

    if (source === 'vertexai') {
        const endpoint = vertexEndpointConfig(profile, oaiSettings);
        const exactServiceAccount = parseServiceAccount(secretValue(
            secrets,
            'vertexai_service_account_json',
            secretId,
            true,
        ));
        const exactExpressKey = secretValue(secrets, 'api_key_vertexai', secretId, true);
        const serviceAccount = exactServiceAccount || parseServiceAccount(secretValue(
            secrets,
            'vertexai_service_account_json',
        ));
        const expressKey = exactExpressKey || secretValue(secrets, 'api_key_vertexai');
        const preferredMode = profile.vertexai_auth_mode
            || profile['auth-mode']
            || oaiSettings.vertexai_auth_mode
            || (serviceAccount ? 'full' : 'express');
        const authMode = exactServiceAccount
            ? 'full'
            : exactExpressKey
                ? 'express'
                : preferredMode === 'full' || (serviceAccount && !expressKey)
                    ? 'full'
                    : 'express';
        return {
            name: profile.name,
            source: 'vertexai',
            model: profile.model,
            authMode,
            serviceAccount,
            apiKey: authMode === 'express' ? expressKey : '',
            projectId: serviceAccount?.project_id
                || profile.vertexai_project
                || profile.vertexai_project_id
                || profile.projectId
                || profile.project_id
                || profile['project-id']
                || endpoint.projectId
                || oaiSettings.vertexai_express_project_id
                || oaiSettings.vertexai_project_id
                || oaiSettings.vertexai_project
                || '',
            region: profile.vertexai_region
                || profile.vertexai_location
                || profile.region
                || profile.location
                || endpoint.region
                || (/^[a-z]+(?:-[a-z0-9]+)+\d$|^global$/i.test(String(profile['api-url'] || ''))
                    ? profile['api-url']
                    : '')
                || oaiSettings.vertexai_region
                || oaiSettings.vertexai_location
                || 'global',
            secretId,
        };
    }

    return {
        name: profile.name,
        source,
        model: profile.model,
        apiKey: secretValue(secrets, `api_key_${source}`, secretId),
        customUrl: profile['api-url'] || profile['custom-url'] || profile.reverse_proxy || '',
        secretId,
    };
}

function resolveTextApi(settings) {
    // 텍스트는 반드시 사용자가 고른 ST 연결 프로필에서 해석한다.
    return resolveProfileApi(settings, settings.profileName);
}

function resolveImageApi(settings) {
    // 연결 프로필에서는 인증 정보만 읽는다. 실제 이미지 모델은 챗로그 설정값만 사용한다.
    // 따라서 인증 프로필의 텍스트 모델명이나 -preview 모델명이 이미지 요청으로 전달되지 않는다.
    const api = resolveProfileApi(
        settings,
        settings.imageProfileName || settings.profileName,
        'image',
    );
    if (!api) {
        throw new Error('이미지 연결 프로필을 찾을 수 없습니다');
    }
    if (api.source !== 'vertexai') {
        throw new Error(`이미지 연결 프로필은 Vertex AI여야 합니다 (${api.source})`);
    }
    const imageModel = String(settings.imageModel || 'gemini-3.1-flash-lite-image').trim();
    if (!imageModel) {
        throw new Error('챗로그 이미지 모델이 비어 있습니다');
    }
    if (/-preview(?:$|-)/i.test(imageModel)) {
        throw new Error(`-preview 이미지 모델명은 Vertex 요청에 사용할 수 없습니다 (${imageModel})`);
    }
    if (!/(?:image|imagen|nano)/i.test(imageModel)) {
        throw new Error(`챗로그 설정값이 이미지 모델이 아닙니다 (${imageModel})`);
    }
    if (!api.projectId) {
        throw new Error(`이미지 연결 프로필 "${api.name}"의 프로젝트 ID를 찾을 수 없습니다`);
    }
    if (api.authMode === 'express' && !api.apiKey) {
        throw new Error(`이미지 연결 프로필 "${api.name}"의 Express 키를 찾을 수 없습니다`);
    }
    if (api.authMode === 'full' && !api.serviceAccount) {
        throw new Error(`이미지 연결 프로필 "${api.name}"의 서비스 계정 정보를 찾을 수 없습니다`);
    }
    return {
        ...api,
        authProfileModel: api.model || '',
        model: imageModel,
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
function identityKey(value) {
    if (!value) return '';
    let text = String(value).trim();
    try { text = decodeURIComponent(text); } catch { /* 일반 문자열 */ }
    return path.basename(text)
        .replace(/\.(png|jpe?g|webp|gif|avif)$/i, '')
        .trim()
        .toLowerCase();
}

function metadataIdentityValues(value, key = '', depth = 0, output = []) {
    if (depth > 4 || value == null) return output;
    if (typeof value === 'string' || typeof value === 'number') {
        if (/^(user_name|user_avatar|persona|persona_name|persona_avatar|persona_id)$/i.test(key)
            || /(?:user|persona).*(?:name|avatar|file|id)/i.test(key)) {
            output.push(String(value));
        }
        return output;
    }
    if (Array.isArray(value)) {
        value.forEach(item => metadataIdentityValues(item, key, depth + 1, output));
        return output;
    }
    if (typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) {
            metadataIdentityValues(child, childKey, depth + 1, output);
        }
    }
    return output;
}

function chatPersonaScore(header, persona) {
    if (!persona) return 0;
    const values = metadataIdentityValues(header);
    const personaAvatar = identityKey(persona.avatar || persona.file);
    const personaName = identityKey(persona.name);
    let score = 0;
    for (const value of values) {
        const normalized = identityKey(value);
        if (personaAvatar && normalized === personaAvatar) score = Math.max(score, 3);
        if (personaName && normalized === personaName) score = Math.max(score, 2);
    }
    return score;
}

/**
 * 캐릭터 채팅 폴더에서 연결 페르소나 메타데이터와 일치하는 최신 JSONL을 고른다.
 * 메타데이터가 없는 예전 채팅은 최후에 전체 최신 파일로 폴백한다.
 */
function readRecentChat(settings, memberOrName, limit = 12, persona = null, options = {}) {
    const member = typeof memberOrName === 'string'
        ? { name: memberOrName, avatar: '' }
        : (memberOrName || {});
    const charName = member.name || identityKey(member.avatar);
    if (!charName) return '';

    const chatsRoot = path.join(ST_ROOT, 'data', settings.userHandle || 'default-user', 'chats');
    const directoryNames = [...new Set([
        member.name,
        identityKey(member.avatar),
    ].filter(Boolean))];
    const files = [];

    for (const directoryName of directoryNames) {
        const dir = path.join(chatsRoot, directoryName);
        try {
            for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'))) {
                const absolute = path.join(dir, file);
                const raw = fs.readFileSync(absolute, 'utf-8');
                const firstLine = raw.split('\n').find(Boolean) || '';
                let header = {};
                try { header = JSON.parse(firstLine); } catch { /* 구형/손상 메타 */ }
                files.push({
                    absolute,
                    raw,
                    score: chatPersonaScore(header, persona),
                    time: fs.statSync(absolute).mtimeMs,
                });
            }
        } catch { /* 후보 폴더 없음 */ }
    }
    if (!files.length) return '';

    const matched = files.filter(file => file.score > 0)
        .sort((a, b) => b.score - a.score || b.time - a.time);
    if (!matched.length && persona?.name && options.allowFallback === false) {
        console.warn(`[chatlog] ${charName}의 "${persona.name}" 메타 채팅을 못 찾아 관계 분석에서 제외`);
        return '';
    }
    const selected = matched[0] || files.sort((a, b) => b.time - a.time)[0];
    if (!matched.length && persona?.name) {
        console.warn(`[chatlog] ${charName}의 "${persona.name}" 메타 채팅을 못 찾아 전체 최신 채팅으로 폴백`);
    }

    try {
        const lines = selected.raw.split('\n').filter(Boolean);
        const msgs = [];
        for (const line of lines) {
            try {
                const message = JSON.parse(line);
                if (!message.mes) continue;
                const speaker = message.is_user === true
                    ? `유저(${persona?.name || '유저'})`
                    : message.name === charName
                        ? `캐릭터(${charName})`
                        : `다른 인물(${message.name || '알 수 없음'})`;
                msgs.push(`${speaker}: ${String(message.mes).replace(/\s+/g, ' ').slice(0, 200)}`);
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

// ── Vertex AI 인증·호출 ───────────────────────────────────
function googleUrl({
    model,
    apiKey,
    projectId,
    region = 'global',
}) {
    if (!projectId) throw new Error('Vertex Express 프로젝트 ID가 비어 있습니다');
    const location = region || 'global';
    return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`
        + `/locations/${encodeURIComponent(location)}/publishers/google/models/`
        + `${encodeURIComponent(model)}:generateContent`
        + `?key=${encodeURIComponent(apiKey)}`;
}

async function callGoogle(cfg, body) {
    if (!cfg?.apiKey) throw new Error('Vertex Express API 키가 비어 있습니다');
    const res = await fetch(googleUrl(cfg), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const detail = await res.text();
        console.error('[chatlog] Vertex Express 오류', cfg.model, res.status, detail);
        throw new Error(`vertex-express ${res.status} (${cfg.model}): ${detail.slice(0, 600)}`);
    }
    return res.json();
}

const vertexTokenCache = new Map();

const toBase64Url = value => Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

async function getVertexAccessToken(serviceAccount) {
    if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
        throw new Error('연결 프로필의 Vertex 서비스 계정 JSON을 찾을 수 없음');
    }

    const cacheKey = `${serviceAccount.client_email}:${serviceAccount.private_key_id || ''}`;
    const cached = vertexTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const issuedAt = Math.floor(Date.now() / 1000);
    const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
    const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = toBase64Url(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
    }));
    const unsigned = `${header}.${claim}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key);
    const assertion = `${unsigned}.${toBase64Url(signature)}`;

    const res = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
    });
    if (!res.ok) {
        throw new Error(`vertex OAuth ${res.status}: ${(await res.text()).slice(0, 600)}`);
    }
    const json = await res.json();
    if (!json.access_token) throw new Error('Vertex OAuth 응답에 access_token이 없음');
    vertexTokenCache.set(cacheKey, {
        token: json.access_token,
        expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    });
    return json.access_token;
}

function vertexProfileUrl({ projectId, region = 'global', model }) {
    if (!projectId) throw new Error('연결 프로필의 Vertex 프로젝트 ID를 찾을 수 없음');
    const location = region || 'global';
    const host = location === 'global'
        ? 'aiplatform.googleapis.com'
        : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${encodeURIComponent(projectId)}`
        + `/locations/${encodeURIComponent(location)}/publishers/google/models/`
        + `${encodeURIComponent(model)}:generateContent`;
}

async function callVertexProfile(api, body) {
    if (api.authMode === 'express') {
        return callGoogle({
            model: api.model,
            apiKey: api.apiKey,
            projectId: api.projectId,
            region: api.region,
        }, body);
    }
    const accessToken = await getVertexAccessToken(api.serviceAccount);
    const res = await fetch(vertexProfileUrl(api), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`vertex-profile ${res.status} (${api.model}): ${detail.slice(0, 600)}`);
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

function geminiGenerationConfig(model, wantJson = false) {
    const name = String(model || '').toLowerCase();
    const isGemini3 = /^gemini-3(?:[.-]|$)/.test(name);
    const isGemini3Flash = /^gemini-3(?:\.\d+)?-flash/.test(name);
    const isGemini25Flash = /^gemini-2\.5-flash(?:-lite)?(?:-|$)/.test(name);
    const config = {
        maxOutputTokens: isGemini3 ? 4096 : 2048,
    };

    if (!isGemini3) config.temperature = 1.0;
    if (wantJson) config.responseMimeType = 'application/json';

    if (isGemini3) {
        // Gemini 3.x는 숫자 budget보다 thinkingLevel을 권장한다.
        // Flash 계열은 minimal, minimal 미지원 가능성이 있는 Pro 계열은 low를 쓴다.
        config.thinkingConfig = {
            thinkingLevel: isGemini3Flash ? 'minimal' : 'low',
        };
    } else if (isGemini25Flash) {
        config.thinkingConfig = { thinkingBudget: 0 };
    }

    return config;
}

async function callGemini(api, { system, user, image, json: wantJson }) {
    const parts = [{ text: user }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });

    const generationConfig = geminiGenerationConfig(api.model, wantJson);

    const json = await callVertexProfile(api, {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
    });
    const candidate = json?.candidates?.[0];
    const text = candidate?.content?.parts
        ?.filter(part => part?.thought !== true)
        .map(part => part?.text || '')
        .join('') || '';
    pushDebug({
        type: wantJson ? 'json-text' : 'text',
        model: api.model,
        finishReason: candidate?.finishReason || '',
        output: text.slice(0, 5000),
        usage: json?.usageMetadata || null,
    });
    return text;
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
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');
    if (api.source === 'vertexai') {
        return callGemini(api, payload);
    }
    if (!api.apiKey) throw new Error(`연결 프로필 "${api.name}"의 API 키를 찾을 수 없음`);
    return callOpenAiCompatible(api, payload);
}

// ── JSON 추출 (코드펜스/잡소리에 강함) ──────────────────────
function extractJson(raw) {
    if (!raw) return null;
    const text = String(raw).replace(/```[a-z]*\n?/gi, '').trim();

    // 앞뒤 설명이나 여러 중괄호가 섞여도 첫 번째 완전한 JSON 객체를 찾는다.
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') depth += 1;
            if (char !== '}') continue;
            depth -= 1;
            if (depth !== 0) continue;
            try {
                return JSON.parse(text.slice(start, index + 1));
            } catch {
                break;
            }
        }
    }
    return null;
}

// ── 프롬프트 ──────────────────────────────────────────────
const timeLabel = (ts) => {
    const d = new Date(ts);
    const h = d.getHours();
    const ampm = h < 12 ? '오전' : '오후';
    return `${ampm} ${h % 12 || 12}시 ${String(d.getMinutes()).padStart(2, '0')}분`;
};

function hourSlotKey(ts) {
    const d = new Date(Number(ts));
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
        String(d.getHours()).padStart(2, '0'),
    ].join('-');
}

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
    const sunriseHour = seasonEn === 'summer' ? 5 : seasonEn === 'winter' ? 7 : 6;
    const sunsetHour = seasonEn === 'summer' ? 20 : seasonEn === 'winter' ? 18 : 19;
    const hour = d.getHours();
    const [daypartKo, daypartEn, lightingEn] = hour < sunriseHour
        ? ['새벽/밤', 'night before sunrise', 'Dark outdoor sky; use streetlights, moonlight, or indoor artificial light. No daylight or sunlit windows.']
        : hour < 11
            ? ['아침', 'morning', 'Natural morning daylight with a believable morning sun angle.']
            : hour < 17
                ? ['낮', 'daytime', 'Clear daytime illumination appropriate to the location.']
                : hour < sunsetHour
                    ? ['저녁', 'evening before sunset', 'Late-day or dusk light appropriate to the season; indoor lights may begin to turn on.']
                    : ['밤', 'night', 'Dark outdoor sky with streetlights, city lights, or indoor artificial light. No bright daytime sky or sunlit windows.'];
    return {
        year: d.getFullYear(),
        month,
        day: d.getDate(),
        hour,
        seasonKo,
        seasonEn,
        daypartKo,
        daypartEn,
        lightingEn,
        sunriseHour,
        sunsetHour,
        label: `${d.getFullYear()}년 ${month}월 ${d.getDate()}일 ${seasonKo} ${daypartKo}`,
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

const RELATION_TYPES = new Set([
    'romantic', 'spouse', 'ex', 'family', 'friend', 'close_friend',
    'rival', 'colleague', 'acquaintance', 'hostile', 'unknown',
]);

function truncateContext(value, max = 4000) {
    const text = String(value || '').replace(/\0/g, '').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function samePersona(a, b) {
    if (!a || !b) return false;
    const aAvatar = identityKey(a.avatar || a.file);
    const bAvatar = identityKey(b.avatar || b.file);
    if (aAvatar && bAvatar) return aAvatar === bAvatar;
    const aName = identityKey(a.name);
    const bName = identityKey(b.name);
    return !!aName && aName === bName;
}

function displayPersona(settings, room) {
    return room?.persona || {
        name: settings.userPersonaName || '유저',
        description: '',
        avatar: null,
    };
}

function cleanRelationType(value) {
    const type = String(value || 'unknown').trim().toLowerCase();
    return RELATION_TYPES.has(type) ? type : 'unknown';
}

function relationTypeLabel(type) {
    return {
        romantic: '연인',
        spouse: '배우자',
        ex: '전 연인',
        family: '가족',
        friend: '친구',
        close_friend: '절친',
        rival: '라이벌',
        colleague: '동료',
        acquaintance: '지인',
        hostile: '적대 관계',
        unknown: '관계 불명',
    }[type] || '관계 불명';
}

function normalizeRelationshipGraph(room, parsed) {
    const members = room?.members || [];
    const knownAvatars = new Set(members.map(member => member.avatar));
    const display = room?.persona || { name: '유저', description: '', avatar: null };
    const rawMemberRelations = Array.isArray(parsed?.memberRelations) ? parsed.memberRelations : [];
    const memberRelations = members.map(member => {
        const found = rawMemberRelations.find(item => item?.memberAvatar === member.avatar);
        const type = cleanRelationType(found?.type);
        return {
            memberAvatar: member.avatar,
            memberName: member.name,
            type,
            label: relationTypeLabel(type),
            confidence: found?.confidence === 'explicit' ? 'explicit' : 'unknown',
        };
    });

    const seenPairs = new Set();
    const characterRelations = [];
    for (const item of Array.isArray(parsed?.characterRelations) ? parsed.characterRelations : []) {
        const aAvatar = String(item?.aAvatar || '');
        const bAvatar = String(item?.bAvatar || '');
        if (!knownAvatars.has(aAvatar) || !knownAvatars.has(bAvatar) || aAvatar === bAvatar) continue;
        const key = [aAvatar, bAvatar].sort().join('\u0000');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const type = cleanRelationType(item?.type);
        characterRelations.push({
            aAvatar,
            aName: members.find(member => member.avatar === aAvatar)?.name || aAvatar,
            bAvatar,
            bName: members.find(member => member.avatar === bAvatar)?.name || bAvatar,
            type,
            label: relationTypeLabel(type),
            confidence: item?.confidence === 'explicit' ? 'explicit' : 'unknown',
        });
    }

    const summaryParts = [
        ...memberRelations
            .filter(item => item.confidence === 'explicit' && item.type !== 'unknown')
            .map(item => `${display.name}와 ${item.memberName}: ${item.label}`),
        ...characterRelations
            .filter(item => item.confidence === 'explicit' && item.type !== 'unknown')
            .map(item => `${item.aName}와 ${item.bName}: ${item.label}`),
    ];

    return {
        version: 1,
        status: 'ready',
        generatedAt: Date.now(),
        displayPersona: {
            name: display.name || '유저',
            avatar: display.avatar || null,
        },
        memberRelations,
        characterRelations,
        summary: summaryParts.join(' · ').slice(0, 1000),
        lastError: null,
    };
}

/**
 * 단톡을 만들거나 사용자가 새로고침했을 때만 실행한다.
 * 모든 캐릭터 카드·연결 페르소나·최근 채팅을 한 번 읽고,
 * 이후 호출에는 짧은 관계도만 재사용한다.
 */
async function analyzeRoomRelationships(settings, room) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('관계 분석에 사용할 연결 프로필을 찾을 수 없음');

    const display = displayPersona(settings, room);
    const sources = (room.members || []).map(member => {
        const linked = room?.memberPersonas?.[member.avatar] || null;
        const recent = linked
            ? readRecentChat(settings, member, 10, linked, { allowFallback: false })
            : '';
        return [
            `[멤버 ${member.name}]`,
            `memberAvatar: ${member.avatar}`,
            '[캐릭터 카드]',
            truncateContext(charBlock(member), 4500),
            linked
                ? `[이 캐릭터에게 기존 채팅으로 연결된 페르소나]\n이름: ${linked.name}\n페르소나 avatar: ${linked.avatar || '(없음)'}\n설명: ${truncateContext(linked.description, 2500)}`
                : '[이 캐릭터에게 명시적으로 연결된 페르소나 없음]',
            recent
                ? `[위 연결 페르소나와의 최근 채팅]\n${truncateContext(recent, 3500)}`
                : '[메타데이터가 일치하는 최근 채팅 없음]',
        ].join('\n');
    }).join('\n\n');

    const system = [
        '너는 단체 SNS 로그의 관계 정보를 정리하는 분석기다.',
        '이번 분석은 단톡 생성 시 한 번 실행되고 결과는 이후 댓글·반응·게시물에 공통으로 사용된다.',
        '',
        '[가장 중요한 구분]',
        `- 이 단톡에서 "user"로 글·댓글·반응을 쓰는 실제 표시 인물은 항상 "${display.name}" 한 명이다.`,
        '- 각 캐릭터에게 기존 채팅으로 연결된 다른 페르소나는 관계를 파악하기 위한 자료일 뿐, 현재 단톡에서 user 행동을 한 사람으로 바꾸면 안 된다.',
        `- 표시 페르소나 avatar는 "${display.avatar || '(없음)'}"이다. 연결 페르소나와 avatar가 같을 때만 동일 인물이다. 둘 중 avatar가 없을 때만 이름 일치를 보조 기준으로 쓴다.`,
        `- 동일 인물로 확인된 연결 페르소나의 최근 채팅만 "${display.name}"와 해당 캐릭터의 관계 근거로 사용한다.`,
        `- 다른 이름의 연결 페르소나와의 연애·애칭·질투·소유욕을 "${display.name}"에게 옮기지 않는다.`,
        '',
        '[판정 규칙]',
        '- 캐릭터 카드, 페르소나 설명, 메타데이터가 일치한 최근 채팅에 명시적인 근거가 있을 때만 관계를 확정한다.',
        '- 농담, 순간적인 호칭, 외모나 사진 포즈만으로 연인·가족 관계를 만들지 않는다.',
        '- 애매하거나 자료가 없으면 unknown으로 둔다.',
        '- 이 단톡의 모든 멤버는 확정된 관계를 알고 있는 것으로 정리한다.',
        '',
        'JSON만 출력한다. 마크다운 코드펜스 금지.',
        '{"summary":"확정된 공개 관계의 짧은 요약","memberRelations":[{"memberAvatar":"입력값 그대로","type":"romantic|spouse|ex|family|friend|close_friend|rival|colleague|acquaintance|hostile|unknown","label":"한국어 관계 설명","confidence":"explicit|unknown"}],"characterRelations":[{"aAvatar":"입력값 그대로","bAvatar":"입력값 그대로","type":"위와 같은 값","label":"한국어 관계 설명","confidence":"explicit|unknown"}]}',
        '- memberRelations에는 표시 페르소나와 모든 단톡 멤버의 관계를 멤버당 정확히 한 건씩 넣는다.',
        '- characterRelations에는 두 캐릭터 사이에 명시적 근거가 있는 관계만 넣는다.',
    ].join('\n');

    const user = [
        '[단톡 표시 페르소나 — 현재 user 행동의 유일한 주체]',
        `이름: ${display.name || '유저'}`,
        `페르소나 avatar: ${display.avatar || '(없음)'}`,
        `설명: ${truncateContext(display.description, 3500) || '(설명 없음)'}`,
        '',
        '[단톡 멤버별 자료]',
        sources || '(멤버 없음)',
        '',
        '위 자료만 근거로 단톡 공통 관계도를 JSON으로 작성하라.',
    ].join('\n');

    const raw = await callText(api, { system, user, json: true });
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('단톡 관계 JSON 파싱 실패');
    return normalizeRelationshipGraph(room, parsed);
}

function relationshipGraphBlock(settings, room) {
    const graph = room?.relationshipGraph;
    const display = displayPersona(settings, room);
    const lines = [
        '[단톡 공통 관계도 — 모든 참여자가 알고 있는 사실]',
        `현재 이 단톡에서 user로 글·댓글·반응을 쓰는 사람: ${display.name}`,
        '- user 행동의 작성자를 각 캐릭터에게 개인적으로 연결된 다른 페르소나로 바꾸지 않는다.',
    ];
    if (graph?.status !== 'ready') {
        lines.push('- 저장된 관계 분석이 없으므로 카드에 명시되지 않은 관계는 만들지 않는다.');
        return lines.join('\n');
    }
    for (const relation of graph.memberRelations || []) {
        if (relation.confidence !== 'explicit' || relation.type === 'unknown') continue;
        lines.push(`- ${display.name} ↔ ${relation.memberName}: ${relation.label}`);
    }
    for (const relation of graph.characterRelations || []) {
        if (relation.confidence !== 'explicit' || relation.type === 'unknown') continue;
        lines.push(`- ${relation.aName} ↔ ${relation.bName}: ${relation.label}`);
    }
    if (graph.summary) lines.push(`- 공통 요약: ${graph.summary}`);
    lines.push('- 위에 적히지 않은 두 사람의 관계는 일반 지인 또는 불명으로 취급한다.');
    return lines.join('\n');
}

function characterPhotoBias(member) {
    const source = [
        member?.description,
        member?.personality,
        member?.scenario,
        member?.mesExample,
    ].filter(Boolean).join(' ').toLowerCase();
    const selfieTerms = [
        'outgoing', 'extrovert', 'social', 'confident', 'vain', 'narcissistic',
        'show-off', 'attention-seeking', 'influencer', 'celebrity', 'fashionable',
        '외향', '사교', '과시', '자신감', '관심을 즐', '인플루언서', '패션', '셀카',
    ];
    const everydayTerms = [
        'introvert', 'reserved', 'private', 'quiet', 'shy', 'taciturn',
        'secretive', 'camera-shy', 'hates photos', 'workaholic',
        '내향', '과묵', '사적', '조용', '수줍', '비밀', '카메라를 싫', '사진을 싫', '일중독',
    ];
    const count = terms => terms.reduce((sum, term) => sum + (source.includes(term) ? 1 : 0), 0);
    return Math.max(-15, Math.min(15, (count(selfieTerms) - count(everydayTerms)) * 5));
}

function choosePhotoMode(member, roll = 50, recentModes = []) {
    const bias = characterPhotoBias(member);
    const selfieChance = Math.max(35, Math.min(65, 50 + bias));
    const history = (recentModes || []).filter(mode => mode === 'selfie' || mode === 'everyday');
    const lastThree = history.slice(0, 3);
    const repeated = lastThree.length === 3 && lastThree.every(mode => mode === lastThree[0]);
    const mode = repeated
        ? lastThree[0] === 'selfie' ? 'everyday' : 'selfie'
        : Number(roll) < selfieChance ? 'selfie' : 'everyday';
    return {
        mode,
        bias,
        selfieChance,
        forcedOpposite: repeated,
    };
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
        return displayPersona(settings, room).name;
    }
    return post.authorName
        || room.members.find(m => m.avatar === post.author)?.name
        || post.author;
}

/**
 * 캐릭터끼리 상호작용할 때 양쪽 카드를 분리해 제공한다.
 * 작성자(member)의 카드는 말투·성격 기준이고, 게시자 카드는 관계·상대 정보 확인용이다.
 */
function characterRelationshipBlock(room, post, member) {
    if (post.author === 'user' || post.author === member?.avatar) return '';
    const postAuthor = room?.members?.find(candidate => candidate.avatar === post.author);
    if (!postAuthor) return '';
    return [
        '[게시물 작성자 캐릭터 카드 — 상대 정보와 두 캐릭터의 관계 확인용]',
        charBlock(postAuthor),
        '',
        '[캐릭터 간 관계 적용 규칙]',
        `- 댓글·반응의 말투와 성격은 반드시 "${member.name}"의 카드와 말투 예시를 따른다.`,
        `- "${postAuthor.name}"의 카드는 상대의 정체성과 두 사람의 관계를 확인하는 용도로만 쓴다.`,
        `- "${member.name}"와 연결된 유저 페르소나의 관계·호칭·애정·질투·소유욕은 "${postAuthor.name}"에게 절대 옮기지 않는다.`,
        '- 두 카드에 서로의 이름이나 명확한 관계가 적혀 있을 때만 그 관계, 호칭, 과거, 감정, 위계를 반영한다.',
        '- 명시된 관계가 없으면 같은 단톡의 지인처럼 자연스럽고 중립적으로 반응한다.',
        '- 근거 없이 연인, 여친, 남친, 배우자, 파트너라고 부르거나 애칭·질투·소유욕을 표현하지 않는다.',
        '- 사진 속 사람의 관계를 외모나 포즈만 보고 추측하지 않는다.',
        '- 카드에 없는 친분이나 사건을 새로 만들지 않는다.',
        `- 정보가 충돌하면 "${member.name}" 자신의 관점과 태도는 "${member.name}"의 카드를 우선한다.`,
        `- "${postAuthor.name}"의 말투를 "${member.name}"의 말투로 섞거나 복사하지 않는다.`,
    ].join('\n');
}

function postPhotoLabel(post) {
    if (!post?.image) return '(사진 없음)';
    if (post.photoMode === 'everyday') return '(사람이 나오지 않는 일상 사진 첨부됨)';
    if (post.photoMode === 'selfie') return '(게시자가 직접 찍은 셀카 첨부됨)';
    return '(사진 첨부됨 — 사진만 보고 인물 관계를 추측하지 말 것)';
}

// ── 댓글 생성 ─────────────────────────────────────────────
async function generateComment(settings, room, post, member, options = {}) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const actorPersona = displayPersona(settings, room);
    const linkedPersona = relationshipPersona(settings, room, member);
    const personaName = actorPersona.name || '유저';
    const isOwnPost = post.author === member.avatar;
    const isOtherCharacterPost = post.author !== 'user' && !isOwnPost;
    const recent = !isOtherCharacterPost && samePersona(actorPersona, linkedPersona)
        ? readRecentChat(settings, member, 8, linkedPersona, { allowFallback: false })
        : '';
    const nowTemporal = seasonContext(Date.now());
    const authorName = postAuthorName(settings, room, post, member);
    const targetUserComment = options.replyToCommentId
        ? (post.comments || []).find(c => c.id === options.replyToCommentId && c.author === 'user')
        : [...(post.comments || [])].reverse().find(c => c.author === 'user');
    const isReply = isOwnPost && !!targetUserComment;
    const characterRelation = characterRelationshipBlock(room, post, member);
    const roomRelations = relationshipGraphBlock(settings, room);
    const task = isReply
        ? `네가 챗로그에 올린 게시물에 ${personaName}가 댓글을 달았다. 아래에 [반드시 답할 댓글]로 표시된 바로 그 댓글에 답댓글을 단다.`
        : `${authorName}가 챗로그에 올린 게시물에 댓글을 단다.`;

    const system = [
        `너는 "${member.name}"이다. 아래 인물을 완전히 연기한다.`,
        '',
        '[댓글 작성자 캐릭터 카드 — 말투·성격·행동의 최우선 기준]',
        charBlock(member),
        characterRelation ? `\n${characterRelation}` : '',
        `\n${roomRelations}`,
        !isOtherCharacterPost && actorPersona.description
            ? `\n[현재 단톡에서 실제로 행동한 표시 페르소나]\n이름: ${personaName}\n설명: ${actorPersona.description}`
            : '',
        recent ? `\n[${personaName}와 ${member.name}의 메타데이터 일치 최근 대화 — 말투와 관계만 참고]\n${recent}` : '',
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
        recent ? '- 최근 대화의 분위기와 호칭은 연결된 유저 페르소나에게만 유지하라.' : '',
        `- 현재 댓글 작성 시각은 ${timeLabel(Date.now())}, ${nowTemporal.daypartKo}이다. 아침·낮·저녁·밤 표현을 현재 시각과 맞춘다.`,
        isOtherCharacterPost
            ? '- 다른 캐릭터에게는 연결 페르소나의 애칭·연애 관계·질투·소유욕을 절대 적용하지 않는다.'
            : '',
        '- 사진에 함께 나온 사람을 근거 없이 여친·남친·연인·파트너라고 추측하지 않는다.',
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
        postPhotoLabel(post),
        `현재 댓글 작성 시각: ${timeLabel(Date.now())} (${nowTemporal.daypartKo})`,
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

function cleanGeneratedComment(raw) {
    return String(raw || '')
        .trim()
        .replace(/^["'「『]|["'」』]$/g, '')
        .replace(/^\*+|\*+$/g, '')
        .replace(/^[^:\n]{1,20}:\s*/, '')
        .split('\n')[0]
        .slice(0, 120)
        .trim();
}

async function generateReaction(settings, room, post, member) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const actorPersona = displayPersona(settings, room);
    const linkedPersona = relationshipPersona(settings, room, member);
    const isOtherCharacterPost = post.author !== 'user' && post.author !== member.avatar;
    const recent = !isOtherCharacterPost && samePersona(actorPersona, linkedPersona)
        ? readRecentChat(settings, member, 5, linkedPersona, { allowFallback: false })
        : '';
    const authorName = postAuthorName(settings, room, post, member);
    const characterRelation = characterRelationshipBlock(room, post, member);
    const system = [
        `너는 "${member.name}"이다. 아래 인물의 성격대로 반응한다.`,
        '',
        '[반응 작성자 캐릭터 카드 — 성격·관계 판단의 최우선 기준]',
        charBlock(member),
        characterRelation ? `\n${characterRelation}` : '',
        `\n${relationshipGraphBlock(settings, room)}`,
        recent ? `\n[최근 대화 분위기]\n${recent}` : '',
        isOtherCharacterPost
            ? '\n연결된 유저 페르소나와의 관계·애정·질투·소유욕을 이 게시물 작성자에게 옮기지 않는다.'
            : '',
        '',
        `"${authorName}"의 챗로그 게시물에 이모지 반응 하나를 남긴다.`,
        `반드시 다음 중 딱 하나만 출력한다: ${REACTION_EMOJIS.join(' ')}`,
        '설명, 이름, 문장, 따옴표를 붙이지 마라.',
    ].filter(Boolean).join('\n');

    const user = [
        `[${timeLabel(post.createdAt)}에 올라온 게시물]`,
        post.text ? `글: ${post.text}` : '(글 없음)',
        postPhotoLabel(post),
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

/**
 * 게시물 하나에 대한 댓글과 이모지를 한 번의 호출로 생성해 비용을 줄인다.
 * commentWanted=false면 반응만 생성한다.
 */
async function generateEngagement(settings, room, post, member, options = {}) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const actorPersona = displayPersona(settings, room);
    const linkedPersona = relationshipPersona(settings, room, member);
    const isOtherCharacterPost = post.author !== 'user' && post.author !== member.avatar;
    const recent = !isOtherCharacterPost && samePersona(actorPersona, linkedPersona)
        ? readRecentChat(settings, member, 6, linkedPersona, { allowFallback: false })
        : '';
    const nowTemporal = seasonContext(Date.now());
    const authorName = postAuthorName(settings, room, post, member);
    const commentWanted = options.commentWanted === true;
    const characterRelation = characterRelationshipBlock(room, post, member);
    const system = [
        `너는 "${member.name}"이다. 아래 인물을 완전히 연기한다.`,
        '',
        '[댓글·반응 작성자 캐릭터 카드 — 말투·성격·행동의 최우선 기준]',
        charBlock(member),
        characterRelation ? `\n${characterRelation}` : '',
        `\n${relationshipGraphBlock(settings, room)}`,
        !isOtherCharacterPost && actorPersona.description
            ? `\n[현재 단톡에서 실제로 행동한 표시 페르소나]\n이름: ${actorPersona.name}\n설명: ${actorPersona.description}`
            : '',
        recent ? `\n[최근 대화 분위기와 관계]\n${recent}` : '',
        '',
        `"${authorName}"의 챗로그 게시물에 반응한다.`,
        'JSON만 출력한다. 마크다운 코드펜스 금지.',
        '{"comment":"댓글 또는 빈 문자열","emoji":"허용된 이모지 하나"}',
        `emoji는 반드시 다음 중 하나다: ${REACTION_EMOJIS.join(' ')}`,
        commentWanted
            ? 'comment는 반드시 작성한다. 1~2문장, 40자 내외의 자연스러운 SNS 댓글로 쓴다.'
            : 'comment는 빈 문자열로 둔다.',
        commentWanted && post.author !== 'user'
            ? '다른 캐릭터의 게시물이다. 둘의 성격에 어울리게 짧게 말을 걸되 억지로 친한 척하거나 관계를 새로 만들지 마라.'
            : '',
        isOtherCharacterPost
            ? '연결된 유저 페르소나의 관계·호칭·애정·질투·소유욕을 게시물 작성자에게 절대 옮기지 않는다.'
            : '',
        isOtherCharacterPost
            ? '두 캐릭터 카드에 명시된 관계가 없으면 일반적인 단톡 지인으로 반응하며 애칭이나 연인 표현을 쓰지 않는다.'
            : '',
        '사진이 있으면 사진 속 구체적인 것 하나를 짚을 수 있다.',
        '사진에 함께 나온 사람을 근거 없이 여친·남친·연인·파트너라고 추측하지 않는다.',
        `현재 댓글 작성 시각은 ${timeLabel(Date.now())}, ${nowTemporal.daypartKo}이다. 시간대 표현을 이에 맞춘다.`,
        '나레이션, 행동 묘사, 따옴표, 이름표를 붙이지 마라.',
    ].filter(Boolean).join('\n');
    const user = [
        `[${timeLabel(post.createdAt)}에 올라온 게시물]`,
        post.text ? `글: ${post.text}` : '(글 없음)',
        postPhotoLabel(post),
        `현재 반응 작성 시각: ${timeLabel(Date.now())} (${nowTemporal.daypartKo})`,
        '',
        '지정한 JSON 형식으로만 답하라.',
    ].join('\n');

    const raw = await callText(api, {
        system,
        user,
        image: readImageAsBase64(post.image),
        json: true,
    });
    const parsed = extractJson(raw);
    if (!parsed) {
        const detail = raw && !String(raw).includes('}')
            ? '응답이 중간에 잘림'
            : raw
                ? 'JSON 형식 오류'
                : '빈 응답';
        throw new Error(`댓글·반응 JSON 파싱 실패 (${detail})`);
    }
    const emoji = REACTION_EMOJIS.find(item => String(parsed.emoji).includes(item)) || '👍';
    return {
        comment: commentWanted ? cleanGeneratedComment(parsed.comment) : '',
        emoji,
    };
}

// ── 캐릭터 컷 생성 ────────────────────────────────────────
async function generateCharacterCut(settings, room, member, slotAt, decision = {}) {
    const api = resolveTextApi(settings);
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');

    const forcePost = !!decision.forcePost;
    const persona = relationshipPersona(settings, room, member);
    const recent = readRecentChat(settings, member, 8, persona, { allowFallback: false });
    const personaName = persona.name || settings.userPersonaName || '유저';
    const personaDescription = persona.description || '';
    const temporal = seasonContext(slotAt);
    const photoMode = decision.photoMode === 'selfie' ? 'selfie' : 'everyday';
    const everydayPhoto = photoMode === 'everyday';
    const photoModeRule = everydayPhoto
        ? [
            '[이번 게시물의 사진 유형 — 일상 사진]',
            '- 사람이 한 명도 나오지 않는 게시 캐릭터 시점의 휴대폰 사진이어야 한다.',
            '- 하늘, 거리, 음식, 커피, 책상, 작업 화면, 운동·취미 도구, 소지품, 방, 야경, 반려동물 중 캐릭터와 시간대에 자연스러운 대상을 고른다.',
            '- 셀카, 얼굴, 손을 제외한 신체, 거울 속 사람, 배경 행인처럼 식별 가능한 사람을 넣지 않는다.',
            '- personaVisible은 반드시 false, personaVisualIdentity와 visualIdentity는 빈 문자열로 둔다.',
        ].join('\n')
        : [
            '[이번 게시물의 사진 유형 — 셀카]',
            `- 게시 캐릭터(${member.name})가 직접 찍은 전면 카메라 셀카, 팔을 뻗은 셀카 또는 거울 셀카여야 한다.`,
            '- 다른 사람이 함께 나오면 게시 캐릭터와 같이 찍은 그룹 셀카로 묘사한다.',
            '- 제3자가 찍어준 사진, 멀리서 찍힌 전신 사진, 몰래 찍은 사진, 감시 카메라, 삼각대, 영화 스틸 같은 구도는 금지한다.',
            `- scene에 반드시 "front-facing smartphone selfie taken by ${member.name}" 또는 "mirror selfie taken by ${member.name}"를 명시한다.`,
        ].join('\n');

    const system = [
        `너는 "${member.name}"이다.`,
        '',
        '[캐릭터 카드 — 일상·정체성 판단의 최우선 근거]',
        charBlock(member),
        `\n${relationshipGraphBlock(settings, room)}`,
        personaDescription
            ? `\n[이 캐릭터의 개인 연결 페르소나 — 단톡 표시 페르소나와 다를 수 있음]\n이름: ${personaName}\n설명: ${personaDescription}`
            : `\n[이 캐릭터의 개인 연결 페르소나 — 단톡 표시 페르소나와 다를 수 있음]\n이름: ${personaName}`,
        recent ? `\n[위 개인 연결 페르소나와 메타데이터가 일치한 최근 대화]\n${recent}` : '',
        '',
        '너는 "chatlog" 앱을 확인하고 있다. 이번 시간대에 게시물을 올릴지 먼저 결정한다.',
        '단체 로그의 모든 인물이 매번 올릴 필요는 없다. 캐릭터 카드의 성격과 일상에 따라 독립적으로 결정한다.',
        '',
        '정보 우선순위와 주체 구분:',
        '- 캐릭터 카드가 정체성, 성별, 외모, 직업, 성격, 생활 방식의 최우선 기준이다.',
        '- 단톡 표시 페르소나와 이 캐릭터의 개인 연결 페르소나가 다르면 서로 다른 인물로 취급한다.',
        '- 단톡 공통 관계도에 적힌 관계만 다른 멤버들도 알고 있는 사실로 사용한다.',
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
        photoModeRule,
        '',
        'post가 true일 때 scene 규칙:',
        '- 캐릭터 카드에 적힌 직업, 취미, 성격, 생활 방식과 최근 관계 상황이 자연스럽게 함께 드러나는 일상을 만든다.',
        '- 최근 대화의 사건을 그대로 복사할 필요는 없지만, 지금 관계 때문에 캐릭터가 실제로 할 법한 선택과 행동은 반영한다.',
        '- 이 시각에 이 캐릭터가 실제로 있을 법한 곳, 실제로 보고 있을 법한 것.',
        `- scene은 사진을 올리는 사람이 "${member.name}"임을 전제로 쓴다. 인물이 나오면 이름 또는 "the male character", "his partner"처럼 역할을 명확히 적는다.`,
        '- 장면의 모든 행동·직업·신체 상태가 누구의 것인지 roleCheck로 마지막 검증한다. 서로 뒤바뀌었으면 고쳐서 출력한다.',
        '- caption도 캐릭터가 직접 쓴 말이어야 하며, 유저가 쓴 것처럼 시점을 바꾸지 마라.',
        '- 폰으로 방금 대충 찍어 바로 올린 스냅이어야 한다. 구도가 조금 어긋나도 좋다.',
        '- 조명·장소·사물을 구체적으로. 추상적 표현 금지.',
        `- 현재 달력과 시간대는 ${temporal.label}, ${timeLabel(slotAt)}이다. 장면과 caption의 아침·낮·저녁·밤 표현을 반드시 이 시각에 맞춘다.`,
        `- 이미지 조명 규칙: ${temporal.lightingEn}`,
        `- 장면의 옷차림, 자연광의 길이와 색, 식생과 주변 환경을 ${temporal.seasonKo}에 자연스럽게 맞춘다.`,
        '- 계절만 보고 비·눈·폭염 같은 정확한 날씨를 임의로 만들지는 마라.',
        '- 장면에 명시된 지역이 남반구·열대이거나 실내 환경이라면 그 지역과 장소의 조건을 계절 일반값보다 우선한다.',
    ].filter(Boolean).join('\n');

    const user = [
        `현재 날짜와 시각은 ${temporal.label}, ${timeLabel(slotAt)}이다.`,
        `이번 랜덤 게시 충동은 ${decision.randomRoll ?? 50}/99이다.`,
        `이번 사진 유형은 ${everydayPhoto ? '사람 없는 일상 사진' : '셀카'}로 이미 결정됐다. 다른 유형으로 바꾸지 마라.`,
        `기본 셀카 확률은 50%이며 캐릭터 카드 보정 후 ${decision.selfieChance ?? 50}%다.${decision.forcedOpposite ? ' 같은 유형이 3번 연속되어 이번에는 반대 유형으로 강제됐다.' : ''}`,
        `활동 시간 기준 마지막 게시 후 약 ${Number(decision.activeHoursSinceLastPost || 0).toFixed(1)}시간 지났다.`,
        forcePost
            ? '이번에는 반드시 올린다. 무엇을 찍어 올릴지 JSON으로 답하라.'
            : '이 시각에 정말 올릴지, 건너뛸지 캐릭터답게 결정해 JSON으로 답하라.',
    ].join('\n');

    const raw = await callText(api, { system, user, json: true });
    const parsed = extractJson(raw);
    if (!parsed) {
        const detail = raw && !String(raw).includes('}')
            ? '응답이 중간에 잘림'
            : raw
                ? 'JSON 형식 오류'
                : '빈 응답';
        throw new Error(`게시 여부 JSON 파싱 실패 (${detail})`);
    }

    const shouldPost = forcePost || parsed.post === true || parsed.post === 'true';
    if (!shouldPost) {
        return { skipped: true, text: '', image: null };
    }
    if (!parsed.scene) {
        console.warn('[chatlog] scene 파싱 실패, 원문:', String(raw).slice(0, 200));
    }

    let image = null;
    if (parsed.scene) {
        try {
            const references = everydayPhoto
                ? []
                : [{
                    role: 'posting character',
                    name: member.name,
                    image: readAvatar(settings, member.avatar),
                }];
            if (!everydayPhoto && (parsed.personaVisible === true || parsed.personaVisible === 'true')) {
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
                `${temporal.label} (${temporal.seasonEn}), ${timeLabel(slotAt)}, ${temporal.daypartEn}. ${temporal.lightingEn}`,
                photoMode,
            );
        } catch (e) {
            console.error('[chatlog] 이미지 생성 실패:', e.message);
            throw e;
        }
    }

    if (!image) throw new Error('이미지를 만들지 못해 게시물을 저장하지 않음');
    return {
        skipped: false,
        text: (parsed.caption || '').slice(0, 60),
        image,
        photoMode,
    };
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

async function requestGeneratedImage(api, prompt, references = []) {
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
    return callVertexProfile(api, {
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
    photoMode = 'selfie',
) {
    const imageApi = resolveImageApi(settings);

    const usableReferences = normalizeReferences(references);
    const posterName = member?.name || 'the posting character';
    const everydayPhoto = photoMode === 'everyday';
    const visible = String(visualIdentity || '').trim().slice(0, 500);
    const personaVisible = String(personaVisualIdentity || '').trim().slice(0, 500);
    const identityRule = everydayPhoto
        ? `The photographer is ${posterName}, but ${posterName} and every other person must remain completely out of frame. Do not generate a face, body, reflection, selfie, portrait, crowd, or identifiable bystander.`
        : [
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
    const cameraRule = everydayPhoto
        ? 'Create a first-person rear-camera phone snapshot of ordinary daily life: scenery, sky, food, drink, desk, hobby equipment, belongings, room, street, night view, or a pet. No people or human reflections may appear.'
        : 'Make it a believable front-facing smartphone selfie, arm’s-length selfie, or mirror selfie taken by the posting character, who must be visible in frame. Multiple people must appear together in a group selfie. Never use a third-person, candid observer, tripod, surveillance, cinematic, or someone-else-took-it angle.';
    const seasonRule = temporalContext
        ? `Calendar context: ${temporalContext}. Match clothing, daylight, vegetation and surroundings to this date, season and time. Do not invent rain, snow or extreme weather from the season alone. If the described location has a different climate or the scene is indoors, follow the actual location and environment instead.`
        : '';
    const qualityRule = 'Create the image now as a casual phone snapshot taken moments ago for an immediate social post. Natural available light, slightly imperfect framing, no text, no watermark.';
    const fullPrompt = `${scene}. ${identityRule} ${seasonRule} ${cameraRule} ${qualityRule}`;
    const compactPrompt = everydayPhoto
        ? `${scene}. ${identityRule} ${seasonRule} Generate a casual rear-camera phone snapshot of daily life with absolutely no people. No text or watermark.`
        : `${scene}. ${identityRule} ${seasonRule} Generate a casual phone selfie taken by ${posterName}. No text or watermark.`;
    const attemptLabel = everydayPhoto ? '일상사진' : '인물 참조';
    const attempts = [
        { label: `${attemptLabel}+전체 프롬프트`, prompt: fullPrompt, references: usableReferences },
        { label: `${attemptLabel}+간단 프롬프트`, prompt: compactPrompt, references: usableReferences },
        ...(usableReferences.length
            ? [{ label: '텍스트 외형 폴백', prompt: compactPrompt, references: [] }]
            : []),
    ];

    let inline = null;
    const failures = [];
    for (const attempt of attempts) {
        try {
            const json = await requestGeneratedImage(imageApi, attempt.prompt, attempt.references);
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
    resolveProfileApi,
    resolveTextApi,
    resolveImageApi,
    googleUrl,
    callGoogle,
    getVertexAccessToken,
    vertexProfileUrl,
    callVertexProfile,
    readAvatar,
    readPersonaAvatar,
    readRecentChat,
    getDebug,
    geminiGenerationConfig,
    extractJson,
    generateComment,
    generateReaction,
    generateEngagement,
    generateCharacterCut,
    generateImage,
    timeLabel,
    hourSlotKey,
    seasonContext,
    characterPhotoBias,
    choosePhotoMode,
    chatPersonaScore,
    characterRelationshipBlock,
    displayPersona,
    samePersona,
    postAuthorName,
    normalizeRelationshipGraph,
    relationshipGraphBlock,
    analyzeRoomRelationships,
};
