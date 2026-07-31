/**
 * 챗로그 — AI 호출 모듈
 * 서버에서 SillyTavern 연결 프로필을 해석해 텍스트와 이미지를 생성.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findSillyTavernRoot } = require('./paths');

const ST_ROOT = findSillyTavernRoot();
const DATA_ROOT = path.resolve(ST_ROOT, 'data');
const PUBLIC_ROOT = path.resolve(ST_ROOT, 'public');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VERTEX_REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function normalizeVertexRegion(value) {
    const region = String(value || 'global').trim().toLowerCase();
    if (!VERTEX_REGION_PATTERN.test(region)) {
        throw new Error(`Vertex 리전 형식이 올바르지 않습니다 (${region || '빈 값'})`);
    }
    return region;
}

function assertGoogleVertexUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('Vertex 요청 주소를 만들 수 없습니다');
    }
    const host = parsed.hostname.toLowerCase();
    const isGoogleVertexHost = host === 'aiplatform.googleapis.com'
        || host.endsWith('-aiplatform.googleapis.com');
    if (parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.port
        || !isGoogleVertexHost) {
        throw new Error(`허용되지 않은 Vertex 요청 주소입니다 (${host || '알 수 없음'})`);
    }
    return parsed.toString();
}

function isPathInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return !!relative
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function safeUserHandle(value) {
    const handle = String(value || 'default-user').trim();
    if (!handle
        || handle === '.'
        || handle === '..'
        || handle.includes('\0')
        || handle.includes('/')
        || handle.includes('\\')
        || handle.includes('..')) {
        return 'default-user';
    }
    const candidate = path.resolve(DATA_ROOT, handle);
    return isPathInside(DATA_ROOT, candidate) ? handle : 'default-user';
}

function userDataDir(settings) {
    return path.resolve(DATA_ROOT, safeUserHandle(settings?.userHandle));
}

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
    const userDir = userDataDir(settings);
    const stSettings = loadJson(path.join(userDir, 'settings.json'), {});
    const secrets = loadJson(path.join(userDir, 'secrets.json'), {});

    const connectionManager = stSettings?.extension_settings?.connectionManager
        || stSettings?.extension_settings?.['connection-manager']
        || {};
    const profiles = Array.isArray(connectionManager.profiles)
        ? connectionManager.profiles
        : [];
    const profile = profiles.find(p => p.name === profileName)
        || (!profileName && kind === 'image'
            ? profiles.find(p => (p?.['api-source'] || p?.api) === 'vertexai')
            : null);
    if (!profile) return null;

    const source = profile['api-source'] || profile.api || 'openai';
    const secretId = profile['secret-id'] || profile.secretId || '';
    const oaiSettings = stSettings?.oai_settings || stSettings?.openai_settings || {};

    if (source === 'vertexai') {
        // Connection Manager 프로필에 명시된 endpoint와 ST 전역 설정에 남은
        // endpoint를 구분한다. Express 프로필에 프로젝트 ID가 없을 때 전역의
        // 오래된 프로젝트 ID를 끌어오면 ST의 정상적인 projectless 요청과 달라진다.
        const profileEndpoint = vertexEndpointConfig(profile, {});
        const fallbackEndpoint = vertexEndpointConfig({}, oaiSettings);
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
        const profileProjectId = profile.vertexai_project
            || profile.vertexai_project_id
            || profile.projectId
            || profile.project_id
            || profile['project-id']
            || profileEndpoint.projectId
            || '';
        const fullProjectId = serviceAccount?.project_id
            || profileProjectId
            || fallbackEndpoint.projectId
            || oaiSettings.vertexai_project_id
            || oaiSettings.vertexai_project
            || '';
        return {
            name: profile.name,
            source: 'vertexai',
            model: profile.model,
            authMode,
            serviceAccount,
            apiKey: authMode === 'express' ? expressKey : '',
            // ST Express와 동일하게 프로필 자체에 프로젝트가 없으면
            // projectless publisher endpoint를 사용한다. Full OAuth만 전역
            // 프로젝트 설정으로 폴백한다.
            projectId: authMode === 'express' ? profileProjectId : fullProjectId,
            region: profile.vertexai_region
                || profile.vertexai_location
                || profile.region
                || profile.location
                || profileEndpoint.region
                || (/^[a-z]+(?:-[a-z0-9]+)+\d$|^global$/i.test(String(profile['api-url'] || ''))
                    ? profile['api-url']
                    : '')
                || fallbackEndpoint.region
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
        secretId,
    };
}

function activeProfileName(settings) {
    const userDir = userDataDir(settings);
    const stSettings = loadJson(path.join(userDir, 'settings.json'), {});
    const connectionManager = stSettings?.extension_settings?.connectionManager
        || stSettings?.extension_settings?.['connection-manager']
        || {};
    const profiles = Array.isArray(connectionManager.profiles)
        ? connectionManager.profiles
        : [];
    const selected = connectionManager.selectedProfile
        ?? connectionManager.selected_profile
        ?? connectionManager.activeProfile
        ?? '';
    const selectedId = typeof selected === 'object'
        ? selected?.id ?? selected?.name ?? ''
        : selected;
    const active = profiles.find(profile =>
        String(profile?.id) === String(selectedId)
        || String(profile?.name) === String(selectedId));
    return active?.name || '';
}

function resolveTextApi(settings) {
    // 브라우저가 닫혀 있어도 ST가 저장한 현재 활성 프로필을 서버가 직접 읽는다.
    if (settings?.followActiveProfile !== false) {
        const activeName = activeProfileName(settings);
        const activeApi = activeName
            ? resolveProfileApi(settings, activeName)
            : null;
        // 챗로그는 Vertex 전용이다. 사용자가 ST에서 Claude·GLM 등의 프로필로
        // 잠시 전환해도 그 주소로 챗로그 정보를 보내지 않고 저장된 Vertex
        // 프로필로 폴백한다.
        if (activeApi?.source === 'vertexai') return activeApi;
    }
    // 현재 활성 프로필을 읽지 못하면 챗로그에 마지막으로 저장된 Vertex
    // 프로필로 폴백한다. 구버전 설정에 Claude·GLM 이름이 남아 있더라도
    // 절대 해당 주소를 호출하지 않고 첫 번째 Vertex 프로필을 다시 찾는다.
    const savedApi = resolveProfileApi(settings, settings.profileName);
    if (savedApi?.source === 'vertexai') return savedApi;
    return resolveProfileApi(settings, '', 'image');
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
    if (api.authMode === 'full' && !api.projectId) {
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

function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )) return { ext: 'png', mime: 'image/png' };
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { ext: 'jpg', mime: 'image/jpeg' };
    }
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return { ext: 'webp', mime: 'image/webp' };
    }
    const gif = buffer.subarray(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
    if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const boxLength = buffer.readUInt32BE(0);
        if (boxLength >= 16 && boxLength <= buffer.length) {
            const brands = [];
            for (let offset = 8; offset + 4 <= boxLength; offset += 4) {
                brands.push(buffer.subarray(offset, offset + 4).toString('ascii'));
            }
            if (brands.includes('avif') || brands.includes('avis')) {
                return { ext: 'avif', mime: 'image/avif' };
            }
        }
    }
    return null;
}

function readVerifiedImage(candidate, allowedRoot) {
    const extension = path.extname(candidate).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) return null;
    const rootStat = fs.lstatSync(allowedRoot);
    const fileStat = fs.lstatSync(candidate);
    if (!rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || !fileStat.isFile()
        || fileStat.isSymbolicLink()
        || fileStat.size < 12
        || fileStat.size > MAX_REFERENCE_IMAGE_BYTES) {
        return null;
    }
    const realRoot = fs.realpathSync(allowedRoot);
    const realFile = fs.realpathSync(candidate);
    if (!isPathInside(realRoot, realFile)) return null;
    const buffer = fs.readFileSync(realFile);
    const type = detectImageType(buffer);
    if (!type) return null;
    const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
    if (normalizedExtension !== `.${type.ext}`) return null;
    return { mime: type.mime, data: buffer.toString('base64') };
}

function readReferenceFile(candidates, label, filename) {
    for (const { file, root } of candidates) {
        try {
            const image = readVerifiedImage(file, root);
            if (image) return image;
        } catch { /* 다음 후보 */ }
    }
    console.warn(`[chatlog] ${label} 프사를 못 찾음:`, filename);
    return null;
}

// ── 프사 읽기 (이미지 속 인물 외모 일관성용 레퍼런스) ─────────
function readAvatar(settings, avatarFile) {
    if (!avatarFile) return null;
    const filename = path.basename(String(avatarFile));
    const userDir = userDataDir(settings);
    return readReferenceFile([
        {
            file: path.join(userDir, 'characters', filename),
            root: path.join(userDir, 'characters'),
        },
        {
            file: path.join(PUBLIC_ROOT, 'characters', filename),
            root: path.join(PUBLIC_ROOT, 'characters'),
        },
    ], '캐릭터', filename);
}

function readPersonaAvatar(settings, avatarFile) {
    if (!avatarFile) return null;
    const filename = path.basename(String(avatarFile));
    const userDir = userDataDir(settings);
    return readReferenceFile([
        {
            file: path.join(userDir, 'User Avatars', filename),
            root: path.join(userDir, 'User Avatars'),
        },
        {
            file: path.join(PUBLIC_ROOT, 'User Avatars', filename),
            root: path.join(PUBLIC_ROOT, 'User Avatars'),
        },
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

    const chatsRoot = path.join(userDataDir(settings), 'chats');
    const directoryNames = [...new Set([
        member.name,
        identityKey(member.avatar),
    ].filter(Boolean))];
    const files = [];

    for (const directoryName of directoryNames) {
        // 디렉토리명에 경로 구분자·상위 이동이 들어오면 무시 (경로 탈출 차단)
        const safeName = String(directoryName);
        if (safeName.includes('/') || safeName.includes('\\') || safeName.includes('..')) continue;
        const dir = path.resolve(chatsRoot, safeName);
        try {
            const realChatsRoot = fs.realpathSync(chatsRoot);
            const dirStat = fs.lstatSync(dir);
            const realDir = fs.realpathSync(dir);
            if (!dirStat.isDirectory()
                || dirStat.isSymbolicLink()
                || !isPathInside(realChatsRoot, realDir)) {
                continue;
            }
            for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'))) {
                const absolute = path.resolve(realDir, file);
                if (!isPathInside(realDir, absolute)) continue;
                const fileStat = fs.lstatSync(absolute);
                if (!fileStat.isFile()
                    || fileStat.isSymbolicLink()
                    || fileStat.size > MAX_CHAT_FILE_BYTES) {
                    continue;
                }
                const realFile = fs.realpathSync(absolute);
                if (!isPathInside(realDir, realFile)) continue;
                const raw = fs.readFileSync(realFile, 'utf-8');
                const firstLine = raw.split('\n').find(Boolean) || '';
                let header = {};
                try { header = JSON.parse(firstLine); } catch { /* 구형/손상 메타 */ }
                files.push({
                    absolute: realFile,
                    raw,
                    score: chatPersonaScore(header, persona),
                    time: fileStat.mtimeMs,
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
        const rel = String(webPath).replace(/^\/+/, '');
        const abs = path.resolve(PUBLIC_ROOT, rel);
        // public 폴더 내부의 실제 이미지 파일만 허용한다.
        if (!isPathInside(PUBLIC_ROOT, abs) || !IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
            console.warn('[chatlog] 이미지 읽기 거부 (public 폴더 밖):', webPath);
            return null;
        }
        const stat = fs.lstatSync(abs);
        if (!stat.isFile()
            || stat.isSymbolicLink()
            || stat.size < 12
            || stat.size > MAX_REFERENCE_IMAGE_BYTES) return null;
        const realPublicRoot = fs.realpathSync(PUBLIC_ROOT);
        const realFile = fs.realpathSync(abs);
        if (!isPathInside(realPublicRoot, realFile)) {
            console.warn('[chatlog] 이미지 읽기 거부 (심볼릭 링크 경로):', webPath);
            return null;
        }
        const buf = fs.readFileSync(realFile);
        const type = detectImageType(buf);
        const expectedExtension = path.extname(abs).toLowerCase() === '.jpeg'
            ? '.jpg'
            : path.extname(abs).toLowerCase();
        if (!type || expectedExtension !== `.${type.ext}`) return null;
        return { mime: type.mime, data: buf.toString('base64') };
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
    const location = normalizeVertexRegion(region);
    const modelPath = `${encodeURIComponent(model)}:generateContent`;
    let url;
    if (projectId) {
        url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`
            + `/locations/${encodeURIComponent(location)}/publishers/google/models/`
            + `${modelPath}?key=${encodeURIComponent(apiKey)}`;
    } else {
        const host = location === 'global'
            ? 'aiplatform.googleapis.com'
            : `${location}-aiplatform.googleapis.com`;
        url = `https://${host}/v1/publishers/google/models/`
            + `${modelPath}?key=${encodeURIComponent(apiKey)}`;
    }
    return assertGoogleVertexUrl(url);
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
    // Vertex 서비스 계정의 OAuth 토큰은 Google 공식 주소로만 요청한다.
    // 프로필 JSON의 임의 token_uri 값으로 인증 정보가 전송되지 않게 고정한다.
    const tokenUri = GOOGLE_OAUTH_TOKEN_URL;
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
    const location = normalizeVertexRegion(region);
    const host = location === 'global'
        ? 'aiplatform.googleapis.com'
        : `${location}-aiplatform.googleapis.com`;
    return assertGoogleVertexUrl(`https://${host}/v1/projects/${encodeURIComponent(projectId)}`
        + `/locations/${encodeURIComponent(location)}/publishers/google/models/`
        + `${encodeURIComponent(model)}:generateContent`);
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
let debugEnabled = false;
function pushDebug(entry) {
    if (!debugEnabled) return;
    lastDebug.push({ time: new Date().toLocaleTimeString('ko-KR'), ...entry });
    if (lastDebug.length > 10) lastDebug.shift();
}
function getDebug() { return lastDebug; }
function setDebugEnabled(enabled) {
    debugEnabled = enabled === true;
    if (!debugEnabled) lastDebug.length = 0;
}

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

async function callText(api, payload) {
    if (!api) throw new Error('연결 프로필을 찾을 수 없음');
    if (api.source !== 'vertexai') {
        throw new Error(`챗로그는 Vertex AI 연결 프로필만 지원합니다 (${api.name || api.source})`);
    }
    return callGemini(api, payload);
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
    'rival', 'colleague', 'acquaintance', 'hostile', 'custom', 'unknown',
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
        custom: '직접 입력',
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
            label: String(found?.label || relationTypeLabel(type)).trim().slice(0, 80),
            confidence: found?.confidence === 'manual'
                ? 'manual'
                : found?.confidence === 'explicit' ? 'explicit' : 'unknown',
            locked: found?.locked === true || found?.confidence === 'manual',
            memberCallsPersona: String(found?.memberCallsPersona || '').trim().slice(0, 80),
            personaCallsMember: String(found?.personaCallsMember || '').trim().slice(0, 80),
            forbiddenTerms: String(found?.forbiddenTerms || '').trim().slice(0, 160),
            note: String(found?.note || '').trim().slice(0, 300),
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
            label: String(item?.label || relationTypeLabel(type)).trim().slice(0, 80),
            confidence: item?.confidence === 'manual'
                ? 'manual'
                : item?.confidence === 'explicit' ? 'explicit' : 'unknown',
            locked: item?.locked === true || item?.confidence === 'manual',
            aCallsB: String(item?.aCallsB || '').trim().slice(0, 80),
            bCallsA: String(item?.bCallsA || '').trim().slice(0, 80),
            forbiddenTerms: String(item?.forbiddenTerms || '').trim().slice(0, 160),
            note: String(item?.note || '').trim().slice(0, 300),
        });
    }

    const summaryParts = [
        ...memberRelations
            .filter(item => ['explicit', 'manual'].includes(item.confidence) && item.type !== 'unknown')
            .map(item => `${display.name}와 ${item.memberName}: ${item.label}`),
        ...characterRelations
            .filter(item => ['explicit', 'manual'].includes(item.confidence) && item.type !== 'unknown')
            .map(item => `${item.aName}와 ${item.bName}: ${item.label}`),
    ];

    return {
        version: 2,
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

function mergeRelationshipGraphs(room, previous, analyzed) {
    const normalized = normalizeRelationshipGraph(room, analyzed);
    const lockedMembers = new Map(
        (previous?.memberRelations || [])
            .filter(item => item?.locked === true || item?.confidence === 'manual')
            .map(item => [item.memberAvatar, item]),
    );
    const pairKey = item => [item?.aAvatar, item?.bAvatar].sort().join('\u0000');
    const lockedCharacters = new Map(
        (previous?.characterRelations || [])
            .filter(item => item?.locked === true || item?.confidence === 'manual')
            .map(item => [pairKey(item), item]),
    );
    normalized.memberRelations = normalized.memberRelations.map(item => {
        const locked = lockedMembers.get(item.memberAvatar);
        return locked ? { ...item, ...locked, memberName: item.memberName } : item;
    });
    const mergedCharacters = new Map(
        normalized.characterRelations.map(item => [pairKey(item), item]),
    );
    for (const [key, relation] of lockedCharacters) mergedCharacters.set(key, relation);
    normalized.characterRelations = [...mergedCharacters.values()];
    normalized.summary = [
        ...normalized.memberRelations
            .filter(item => ['explicit', 'manual'].includes(item.confidence) && item.type !== 'unknown')
            .map(item => `${normalized.displayPersona.name}와 ${item.memberName}: ${item.label}`),
        ...normalized.characterRelations
            .filter(item => ['explicit', 'manual'].includes(item.confidence) && item.type !== 'unknown')
            .map(item => `${item.aName}와 ${item.bName}: ${item.label}`),
    ].join(' · ').slice(0, 1000);
    return normalized;
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
    return mergeRelationshipGraphs(room, room?.relationshipGraph, parsed);
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
        if (!['explicit', 'manual'].includes(relation.confidence) || relation.type === 'unknown') continue;
        lines.push(`- [고정 관계 ID user↔${relation.memberAvatar}] ${display.name} ↔ ${relation.memberName}: ${relation.label}`);
        if (relation.memberCallsPersona) {
            lines.push(`  · ${relation.memberName}가 ${display.name}를 부를 때 허용된 호칭: ${relation.memberCallsPersona}`);
        }
        if (relation.personaCallsMember) {
            lines.push(`  · ${display.name}가 ${relation.memberName}를 부를 때 허용된 호칭: ${relation.personaCallsMember}`);
        }
        if (relation.forbiddenTerms) lines.push(`  · 이 둘 사이 금지 호칭·관계 표현: ${relation.forbiddenTerms}`);
        if (relation.note) lines.push(`  · 관계 메모: ${relation.note}`);
    }
    for (const relation of graph.characterRelations || []) {
        if (!['explicit', 'manual'].includes(relation.confidence) || relation.type === 'unknown') continue;
        lines.push(`- [고정 관계 ID ${relation.aAvatar}↔${relation.bAvatar}] ${relation.aName} ↔ ${relation.bName}: ${relation.label}`);
        if (relation.aCallsB) lines.push(`  · ${relation.aName}가 ${relation.bName}를 부르는 호칭: ${relation.aCallsB}`);
        if (relation.bCallsA) lines.push(`  · ${relation.bName}가 ${relation.aName}를 부르는 호칭: ${relation.bCallsA}`);
        if (relation.forbiddenTerms) lines.push(`  · 이 둘 사이 금지 호칭·관계 표현: ${relation.forbiddenTerms}`);
        if (relation.note) lines.push(`  · 관계 메모: ${relation.note}`);
    }
    if (graph.summary) lines.push(`- 공통 요약: ${graph.summary}`);
    lines.push('- 위에 적히지 않은 두 사람의 관계는 일반 지인 또는 불명으로 취급한다.');
    return lines.join('\n');
}

function exactRelationFor(room, actorAvatar, targetAvatar) {
    const graph = room?.relationshipGraph;
    if (graph?.status !== 'ready') return null;
    if (targetAvatar === 'user') {
        return (graph.memberRelations || []).find(item => item.memberAvatar === actorAvatar) || null;
    }
    if (actorAvatar === 'user') {
        return (graph.memberRelations || []).find(item => item.memberAvatar === targetAvatar) || null;
    }
    return (graph.characterRelations || []).find(item =>
        (item.aAvatar === actorAvatar && item.bAvatar === targetAvatar)
        || (item.aAvatar === targetAvatar && item.bAvatar === actorAvatar)) || null;
}

function scopedRelationshipRules(settings, room, member, post) {
    const targetAvatar = post.author === 'user' ? 'user' : post.author;
    const targetName = postAuthorName(settings, room, post, member);
    const relation = exactRelationFor(room, member.avatar, targetAvatar);
    const lines = [
        '[이번 반응의 화자·대상 잠금]',
        `- SPEAKER_ID=${member.avatar}`,
        `- SPEAKER_NAME=${member.name}`,
        `- TARGET_ID=${targetAvatar}`,
        `- TARGET_NAME=${targetName}`,
        `- 지금 말하는 사람은 오직 ${member.name}이다. 표시 페르소나나 게시물 작성자의 1인칭으로 말하지 않는다.`,
        `- 댓글에서 ${member.name} 자신을 "${displayPersona(settings, room).name}"로 착각하지 않는다.`,
    ];
    if (!relation || relation.type === 'unknown') {
        lines.push('- 이 화자와 대상 사이에 고정된 관계가 없다. 일반 단톡 지인으로 대하고 연애·배우자·가족·애칭을 만들지 않는다.');
        return lines.join('\n');
    }
    lines.push(`- 이 둘의 고정 관계: ${relation.label || relationTypeLabel(relation.type)} (${relation.type})`);
    let allowedCall = '';
    if (targetAvatar === 'user') allowedCall = relation.memberCallsPersona || '';
    else if (relation.aAvatar === member.avatar) allowedCall = relation.aCallsB || '';
    else allowedCall = relation.bCallsA || '';
    if (allowedCall) {
        lines.push(`- ${member.name}가 ${targetName}를 부를 때 허용된 호칭: ${allowedCall}`);
        lines.push('- 허용 목록 밖의 관계성 애칭은 쓰지 않는다.');
    } else {
        lines.push(`- ${targetName}의 이름 또는 캐릭터 카드에 명시된 중립 호칭만 쓴다. 새 애칭을 만들지 않는다.`);
    }
    if (relation.forbiddenTerms) lines.push(`- 반드시 피할 호칭·표현: ${relation.forbiddenTerms}`);
    if (relation.note) lines.push(`- 관계 메모: ${relation.note}`);
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

function ratioAwareRunLimit(chance) {
    const normalized = Math.max(0, Math.min(100, Number(chance) || 0));
    if (normalized === 0 || normalized === 100) return Number.POSITIVE_INFINITY;
    const opposite = 100 - normalized;
    if (normalized <= opposite) return 2;
    return Math.max(2, Math.ceil(normalized / opposite));
}

function consecutiveRun(history = []) {
    if (!history.length) return { value: null, length: 0 };
    const value = history[0];
    let length = 0;
    for (const item of history) {
        if (item !== value) break;
        length += 1;
    }
    return { value, length };
}

function ratioBalancedChance(chance, history = [], positiveValue, windowSize = 20) {
    const normalized = Math.max(0, Math.min(100, Number(chance) || 0));
    if (normalized === 0 || normalized === 100) return normalized;
    const window = Math.max(2, Math.floor(Number(windowSize) || 20));
    const relevant = history.slice(0, window - 1);
    const positiveCount = relevant.filter(value => value === positiveValue).length;
    const desiredPositiveCount = (relevant.length + 1) * normalized / 100;
    return Math.max(0, Math.min(100, (desiredPositiveCount - positiveCount) * 100));
}

function choosePhotoMode(member, roll = 50, recentModes = [], baseSelfieChance = 50) {
    const bias = characterPhotoBias(member);
    const baseChance = Math.max(0, Math.min(100, Number(baseSelfieChance) || 0));
    const selfieChance = baseChance === 0 || baseChance === 100
        ? baseChance
        : Math.max(0, Math.min(100, baseChance + bias));
    const history = (recentModes || []).filter(mode => mode === 'selfie' || mode === 'everyday');
    const streak = consecutiveRun(history);
    const streakChance = streak.value === 'selfie' ? selfieChance : 100 - selfieChance;
    const streakLimit = ratioAwareRunLimit(streakChance);
    const forcedOpposite = streak.value !== null
        && Number.isFinite(streakLimit)
        && streak.length >= streakLimit;
    const balancedSelfieChance = ratioBalancedChance(selfieChance, history, 'selfie');
    const mode = forcedOpposite
        ? streak.value === 'selfie' ? 'everyday' : 'selfie'
        : Number(roll) < balancedSelfieChance ? 'selfie' : 'everyday';
    return {
        mode,
        photoMode: mode,
        bias,
        baseSelfieChance: baseChance,
        selfieChance,
        balancedSelfieChance,
        forcedOpposite,
        forcedFrom: forcedOpposite ? streak.value : null,
        streakLength: streak.length,
        streakLimit: Number.isFinite(streakLimit) ? streakLimit : null,
    };
}

function chooseCompanionSelfie({
    photoMode = 'everyday',
    eligible = false,
    chance = 45,
    roll = 50,
    recentCompanionFlags = [],
} = {}) {
    const normalizedChance = Math.max(0, Math.min(100, Number(chance) || 0));
    if (photoMode !== 'selfie' || !eligible) {
        return {
            includePersona: false,
            chance: normalizedChance,
            forcedOpposite: false,
            forcedFrom: null,
            forcedAfterSoloRun: false,
            streakLength: 0,
            streakLimit: null,
        };
    }
    const recent = (recentCompanionFlags || [])
        .filter(value => typeof value === 'boolean');
    const streak = consecutiveRun(recent);
    const streakChance = streak.value === true ? normalizedChance : 100 - normalizedChance;
    const streakLimit = ratioAwareRunLimit(streakChance);
    const forcedOpposite = normalizedChance > 0
        && normalizedChance < 100
        && streak.value !== null
        && Number.isFinite(streakLimit)
        && streak.length >= streakLimit;
    const balancedCompanionChance = ratioBalancedChance(
        normalizedChance,
        recent,
        true,
    );
    const includePersona = normalizedChance === 100
        ? true
        : normalizedChance === 0
            ? false
            : forcedOpposite
                ? !streak.value
                : Number(roll) < balancedCompanionChance;
    const forcedAfterSoloRun = forcedOpposite && streak.value === false;
    return {
        includePersona,
        chance: normalizedChance,
        balancedCompanionChance,
        forcedOpposite,
        forcedFrom: forcedOpposite ? streak.value : null,
        forcedAfterSoloRun,
        streakLength: streak.length,
        streakLimit: Number.isFinite(streakLimit) ? streakLimit : null,
    };
}

function relationAllowsCompanion(room, member, persona) {
    const linked = room?.memberPersonas?.[member?.avatar];
    if (linked && samePersona(linked, persona)) return true;
    if (!samePersona(displayPersona({}, room), persona)) return false;
    const relation = exactRelationFor(room, member?.avatar, 'user');
    if (!relation || !['manual', 'explicit'].includes(relation.confidence)) return false;
    if (relation.type === 'romantic' || relation.type === 'spouse') return true;
    if (relation.type !== 'custom') return false;
    return /(?:연인|배우자|애인|여친|남친|아내|남편|약혼|커플|lover|partner|spouse|wife|husband|girlfriend|boyfriend|dating)/iu
        .test(`${relation.label || ''} ${relation.note || ''}`);
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
    if (post.presenceKnown === true) {
        const visibleNames = (post.visiblePeople || [])
            .map(person => person?.name)
            .filter(Boolean);
        const visibleIds = new Set((post.visiblePeople || []).map(person => person?.id));
        const offCameraNames = (post.presentPeople || [])
            .filter(person => !visibleIds.has(person?.id))
            .map(person => person?.name)
            .filter(Boolean);
        return [
            '(사진 속 인물 정보는 서버가 생성 시 확정한 값이며 이미지 외형으로 다시 추측하지 말 것)',
            `사진에 실제로 보이는 인물: ${visibleNames.length ? visibleNames.join(', ') : '없음'}`,
            `같은 현장에 있지만 사진에는 보이지 않는 인물: ${offCameraNames.length ? offCameraNames.join(', ') : '없음'}`,
            post.sceneContext?.locationKo
                ? `공유 장면 장소: ${post.sceneContext.locationKo}`
                : '',
        ].filter(Boolean).join('\n');
    }
    if (post.photoMode === 'everyday') return '(사람이 나오지 않는 일상 사진 첨부됨)';
    if (post.photoMode === 'selfie' && post.withPersona) {
        return `(게시자가 연결 페르소나 ${post.companionName || '동반자'}와 함께 직접 찍은 셀카 첨부됨 — 저장된 관계만 적용할 것)`;
    }
    if (post.photoMode === 'selfie') return '(게시자가 직접 찍은 셀카 첨부됨)';
    return '(사진 첨부됨 — 사진만 보고 인물 관계를 추측하지 말 것)';
}

function personIdSet(people) {
    return new Set((people || []).map(person => String(person?.id || '')).filter(Boolean));
}

function postPresenceRules(room, post, member) {
    const speakerId = String(member?.avatar || '');
    if (post?.presenceKnown !== true) {
        return [
            '[사진 참석 여부 잠금]',
            '- 이 사진은 수동 업로드 또는 이전 버전 게시물이라 등장 인물 ID가 확인되지 않았다.',
            `- ${member.name}가 사진에 나왔거나 촬영 현장에 있었다고 추측하지 않는다.`,
            '- "나 잘 나왔네", "내가 찍혔네", "우리 사진", "그때 나도 거기 있었지"처럼 자기 참석을 전제로 말하지 않는다.',
            '- 이미지에 닮은 사람이 보여도 방 멤버나 특정 페르소나라고 단정하지 않는다.',
        ].join('\n');
    }

    const visible = personIdSet(post.visiblePeople);
    const present = personIdSet(post.presentPeople);
    // 게시자는 최소한 촬영 현장에는 있었다.
    if (String(post.author || '') === speakerId) present.add(speakerId);
    const speakerVisible = visible.has(speakerId);
    const speakerPresent = present.has(speakerId);
    const visibleNames = (post.visiblePeople || []).map(person => person.name).filter(Boolean);
    const presentNames = (post.presentPeople || []).map(person => person.name).filter(Boolean);
    const lines = [
        '[사진 참석 여부 잠금 — 저장된 ID가 이미지 추측보다 우선]',
        `- 사진에 실제로 보이는 인물: ${visibleNames.length ? visibleNames.join(', ') : '없음'}`,
        `- 현장 참석자: ${presentNames.length ? presentNames.join(', ') : '없음'}`,
        `- 댓글 작성자 ${member.name}의 상태: ${speakerVisible
            ? '사진에 실제로 보임'
            : speakerPresent ? '현장에는 있었지만 사진에는 보이지 않음' : '현장에 없었고 사진에도 보이지 않음'}`,
        '- 목록에 없는 배경 인물은 정체 불명의 일반인이다. 방 멤버나 페르소나로 추측하지 않는다.',
    ];
    if (!speakerVisible) {
        lines.push(`- ${member.name}는 사진에 보이지 않으므로 자기 외모·표정·포즈·사진발을 언급하거나 "나 잘 나왔네"라고 말할 수 없다.`);
    }
    if (!speakerPresent) {
        lines.push(`- ${member.name}는 현장에 없었으므로 같이 갔다거나 옆에 있었다거나 자신이 찍었다고 말할 수 없다.`);
    } else if (!speakerVisible) {
        lines.push(`- ${member.name}는 현장을 기억하는 말은 할 수 있지만, 사진 속 자기 모습을 묘사할 수는 없다.`);
    }
    return lines.join('\n');
}

function violatesPresenceClaim(comment, post, member) {
    const text = String(comment || '').trim();
    if (!text) return false;
    const speakerId = String(member?.avatar || '');
    const known = post?.presenceKnown === true;
    const visible = personIdSet(post?.visiblePeople);
    const present = personIdSet(post?.presentPeople);
    if (String(post?.author || '') === speakerId) present.add(speakerId);
    const speakerVisible = known && visible.has(speakerId);
    const speakerPresent = known && present.has(speakerId);
    const selfVisualClaim = /(?:(?:내가|나는|나|내\s*(?:얼굴|모습|표정|포즈))\s*(?:진짜\s*)?(?:잘\s*)?(?:나왔|찍혔|보이|예쁘|멋있|이상하)|(?:사진\s*속|저기)\s*(?:사람이\s*)?(?:나|내가)|\b(?:i\s+(?:look|came\s+out|am\s+in)|that'?s\s+me)\b)/iu;
    const sharedPhotoClaim = /(?:(?:우리|같이)\s*(?:찍은|찍힌|나온)?\s*사진|(?:내가|우리가)\s*(?:찍었|찍은))/iu;
    const onsiteClaim = /(?:(?:나도|내가|우리가|우리)\s*(?:거기|저기|현장|옆|같이)\s*(?:있|갔|왔|앉|먹|마셨)|(?:나도|내가)\s*(?:같이\s*)?(?:갔|있었|주문했))/iu;
    if (!speakerVisible && selfVisualClaim.test(text)) return true;
    if (!speakerPresent && (sharedPhotoClaim.test(text) || onsiteClaim.test(text))) return true;
    return false;
}

const COMMENT_INTENTS = {
    detail: '사진이나 글의 구체적인 사물·행동 하나만 짚어서 반응한다.',
    tease: '캐릭터다운 가벼운 장난이나 빈정거림으로 반응하되 관계를 과장하지 않는다.',
    question: '사진이나 글에서 자연스럽게 생기는 짧은 질문 하나를 한다.',
    opinion: '캐릭터 성격이 드러나는 짧은 의견이나 평가를 남긴다.',
    practical: '현실적이고 실용적인 한마디를 한다. 잔소리형이면 캐릭터답게 짧게 한다.',
    callback: '캐릭터 카드나 실제로 제공된 최근 대화에 있는 구체적 습관을 짧게 연결한다. 없는 사건은 만들지 않는다.',
    minimal: '말수가 적은 사람처럼 아주 짧고 특징적인 한마디만 남긴다.',
};

function commentIntentRules(intent, existingComments = [], recentComments = []) {
    const selected = COMMENT_INTENTS[intent] || COMMENT_INTENTS.detail;
    const existing = existingComments
        .map(item => String(item?.text || '').trim())
        .filter(Boolean)
        .slice(-8);
    const recent = recentComments
        .map(item => String(item?.text ?? item ?? '').trim())
        .filter(Boolean)
        .slice(0, 12);
    return [
        '[이번 댓글의 표현 방향]',
        `- ${selected}`,
        '- 특별히 시간 자체가 주제인 게시물이 아니면 "이 시간에", "이 새벽에", "이 저녁에", "아직 안 자", "얼른 자" 같은 시간·수면 상투어를 쓰지 않는다.',
        '- 다른 댓글의 문장 구조, 첫 단어, 질문 방식을 따라 하지 않는다.',
        '- 단어 몇 개만 바꾸는 재작성도 금지한다. 이미 나온 핵심 소재·명령·결론의 조합 대신 사진이나 글의 다른 세부사항을 고른다.',
        existing.length ? `- 이미 사용된 댓글과 다른 관점으로 쓴다: ${existing.join(' / ')}` : '',
        recent.length ? `- 이 방의 최근 댓글에서도 표현과 핵심 관점을 재사용하지 않는다: ${recent.join(' / ')}` : '',
    ].filter(Boolean).join('\n');
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
        `\n${scopedRelationshipRules(settings, room, member, post)}`,
        `\n${postPresenceRules(room, post, member)}`,
        `\n${commentIntentRules(options.commentIntent, post.comments || [], options.recentComments || [])}`,
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
        `- "유저", "user", "페르소나", "persona"는 내부 역할표시일 뿐 실제 호칭이 아니다. 댓글에서 상대를 이 단어로 부르지 말고, 관계도에 허용된 호칭이나 실제 이름 "${authorName}"만 사용한다.`,
        recent ? '- 최근 대화의 분위기와 호칭은 연결된 유저 페르소나에게만 유지하라.' : '',
        `- 현재 댓글 작성 시각은 ${timeLabel(Date.now())}, ${nowTemporal.daypartKo}이다. 시간 표현이 꼭 필요할 때만 현재 시각과 맞춘다.`,
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

    let comment = cleanGeneratedComment(raw);
    if (exposesInternalRoleLabel(comment)
        || violatesPresenceClaim(comment, post, member)
        || repeatsExistingComment(comment, post.comments || [], options.recentComments || [])) {
        const retryReason = exposesInternalRoleLabel(comment)
            ? '첫 답변은 내부 역할명("유저/user/페르소나/persona")을 실제 호칭처럼 써서 폐기됐다. 그 단어들을 쓰지 말고 실제 이름이나 허용된 호칭으로 완전히 다시 작성하라.'
            : violatesPresenceClaim(comment, post, member)
                ? '첫 답변은 저장된 사진 참석자 ID와 충돌했다. 사진에 보이지 않는 화자의 외모를 말하거나 현장에 없던 화자가 함께 있었다고 말하지 말고, 게시물에서 실제로 확인되는 다른 요소에 반응하라.'
            : '첫 답변은 같은 게시물 또는 이 방의 최근 댓글과 문장 구조·핵심 소재·명령 방식이 겹쳐 폐기됐다. 사진이나 글의 다른 세부사항을 골라 완전히 다른 관점과 말투로 다시 작성하라.';
        const retryRaw = await callText(api, {
            system,
            user: `${user}\n\n${retryReason}`,
            image: readImageAsBase64(post.image),
        });
        comment = cleanGeneratedComment(retryRaw);
    }
    return exposesInternalRoleLabel(comment)
        || violatesPresenceClaim(comment, post, member)
        || repeatsExistingComment(comment, post.comments || [], options.recentComments || [])
        ? ''
        : comment;
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

function exposesInternalRoleLabel(value) {
    return /(?:유저|페르소나|\buser\b|\bpersona\b)/iu.test(String(value || ''));
}

function commentBigrams(value) {
    const normalized = String(value || '')
        .toLowerCase()
        .replace(/(?:이\s*시간에|이\s*새벽에|이\s*저녁에|아직\s*안\s*자|얼른\s*자)/g, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
    const result = new Set();
    for (let index = 0; index < normalized.length - 1; index++) {
        result.add(normalized.slice(index, index + 2));
    }
    return result;
}

function commentSimilarity(a, b) {
    const left = commentBigrams(a);
    const right = commentBigrams(b);
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const item of left) if (right.has(item)) intersection++;
    return intersection / Math.max(left.size, right.size);
}

const COMMENT_MOTIFS = [
    ['phone', /(?:휴대폰|핸드폰|스마트폰|폰|화면|스크롤)/iu],
    ['drink', /(?:술|맥주|소주|숙취|해장|얼음물|물이나|수분|마셔|마시)/iu],
    ['sleep', /(?:잠|자라|자냐|안\s*자|밤새|새벽|피곤)/iu],
    ['training', /(?:훈련|운동|체육관|헬스|짐\b|라커|쿼터백|드라이브)/iu],
    ['food', /(?:밥|먹|음식|야식|아침|점심|저녁|과일|간식)/iu],
    ['contact', /(?:연락|전화|답장|메시지|문자)/iu],
    ['wash', /(?:씻|샤워|세수|땀)/iu],
    ['clothes', /(?:옷|티셔츠|바지|재킷|신발|입었|벗)/iu],
];

function commentMotifs(value) {
    const text = String(value || '');
    return new Set(COMMENT_MOTIFS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name));
}

function commentShapes(value) {
    const text = String(value || '');
    const shapes = new Set();
    if (/[?？]/u.test(text) || /(?:냐|거냐|하냐|했냐|할래)(?:\W|$)/u.test(text)) shapes.add('question');
    if (/(?:그만|마셔|마시|자라|치워|놔라|해라|하지\s*마|말고|챙겨|씻|정신\s*차려)/u.test(text)) shapes.add('directive');
    if (/(?:ㅋㅋ|ㅎㅎ|ㅋ|ㅎ)/u.test(text)) shapes.add('laugh');
    return shapes;
}

function sharedSetSize(left, right) {
    let count = 0;
    for (const item of left) if (right.has(item)) count++;
    return count;
}

function commentText(item) {
    return String(item?.text ?? item ?? '').trim();
}

function repeatsExistingComment(comment, comments = [], recentComments = []) {
    const candidate = commentText(comment);
    if (!candidate) return false;
    const motifs = commentMotifs(candidate);
    const shapes = commentShapes(candidate);

    const samePostDuplicate = comments.some(item => {
        const previous = commentText(item);
        if (!previous) return false;
        if (commentSimilarity(candidate, previous) >= 0.56) return true;
        return sharedSetSize(motifs, commentMotifs(previous)) >= 2;
    });
    if (samePostDuplicate) return true;

    return recentComments.some(item => {
        const previous = commentText(item);
        if (!previous) return false;
        if (commentSimilarity(candidate, previous) >= 0.62) return true;
        const sharedMotifs = sharedSetSize(motifs, commentMotifs(previous));
        const sharedShapes = sharedSetSize(shapes, commentShapes(previous));
        return sharedMotifs >= 2 && sharedShapes >= 1;
    });
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
        `\n${scopedRelationshipRules(settings, room, member, post)}`,
        `\n${postPresenceRules(room, post, member)}`,
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
        `\n${scopedRelationshipRules(settings, room, member, post)}`,
        `\n${postPresenceRules(room, post, member)}`,
        commentWanted
            ? `\n${commentIntentRules(options.commentIntent, post.comments || [], options.recentComments || [])}`
            : '',
        !isOtherCharacterPost && actorPersona.description
            ? `\n[현재 단톡에서 실제로 행동한 표시 페르소나]\n이름: ${actorPersona.name}\n설명: ${actorPersona.description}`
            : '',
        recent ? `\n[최근 대화 분위기와 관계]\n${recent}` : '',
        '',
        `"${authorName}"의 챗로그 게시물에 반응한다.`,
        'JSON만 출력한다. 마크다운 코드펜스 금지.',
        `{"speakerId":${JSON.stringify(member.avatar)},"targetId":${JSON.stringify(post.author === 'user' ? 'user' : post.author)},"comment":"댓글 또는 빈 문자열","emoji":"허용된 이모지 하나"}`,
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
        `댓글에서 "유저", "user", "페르소나", "persona"를 상대 호칭으로 절대 출력하지 않는다. 이는 내부 역할표시다. 필요하면 실제 이름 "${authorName}" 또는 관계도에 허용된 호칭만 사용한다.`,
        `현재 댓글 작성 시각은 ${timeLabel(Date.now())}, ${nowTemporal.daypartKo}이다. 시간 표현이 꼭 필요할 때만 현재 시각과 맞춘다.`,
        '나레이션, 행동 묘사, 따옴표, 이름표를 붙이지 마라.',
    ].filter(Boolean).join('\n');
    const user = [
        `[${timeLabel(post.createdAt)}에 올라온 게시물]`,
        post.text ? `글: ${post.text}` : '(글 없음)',
        postPhotoLabel(post),
        `현재 반응 작성 시각: ${timeLabel(Date.now())} (${nowTemporal.daypartKo})`,
        commentWanted ? othersBlock(post, member) : '',
        '',
        '지정한 JSON 형식으로만 답하라.',
    ].join('\n');

    const request = {
        system,
        user,
        image: readImageAsBase64(post.image),
        json: true,
    };
    const raw = await callText(api, request);
    let parsed = extractJson(raw);
    if (!parsed) {
        const detail = raw && !String(raw).includes('}')
            ? '응답이 중간에 잘림'
            : raw
                ? 'JSON 형식 오류'
                : '빈 응답';
        throw new Error(`댓글·반응 JSON 파싱 실패 (${detail})`);
    }
    const expectedTarget = post.author === 'user' ? 'user' : post.author;
    if (String(parsed.speakerId || '') !== String(member.avatar)
        || String(parsed.targetId || '') !== String(expectedTarget)) {
        throw new Error('댓글·반응 화자 ID 검증 실패');
    }
    const emoji = REACTION_EMOJIS.find(item => String(parsed.emoji).includes(item)) || '👍';
    let comment = commentWanted ? cleanGeneratedComment(parsed.comment) : '';
    if (commentWanted && comment
        && (repeatsExistingComment(
            comment,
            post.comments || [],
            options.recentComments || [],
        ) || exposesInternalRoleLabel(comment)
            || violatesPresenceClaim(comment, post, member))) {
        try {
            const retryReason = exposesInternalRoleLabel(comment)
                ? '첫 후보 댓글은 내부 역할명("유저/user/페르소나/persona")을 실제 호칭처럼 써서 폐기됐다. 그 단어를 전부 빼고 실제 이름이나 허용된 호칭을 사용한다.'
                : violatesPresenceClaim(comment, post, member)
                    ? '첫 후보 댓글은 저장된 사진 참석자 ID와 충돌했다. 사진에 보이지 않는 화자의 외모를 말하거나 현장에 없던 화자가 함께 있었다고 말하지 않는다.'
                : '첫 후보 댓글은 같은 게시물 또는 이 방의 최근 댓글과 문장 구조·핵심 소재·명령 방식이 너무 비슷해 폐기됐다. 사진이나 글의 다른 세부사항을 골라 관점과 말투를 완전히 바꾼다.';
            const retryRaw = await callText(api, {
                ...request,
                user: `${user}\n\n${retryReason} 수정한 JSON을 한 번만 다시 출력하라.`,
            });
            const retryParsed = extractJson(retryRaw);
            if (String(retryParsed?.speakerId || '') === String(member.avatar)
                && String(retryParsed?.targetId || '') === String(expectedTarget)) {
                const retryComment = cleanGeneratedComment(retryParsed.comment);
                comment = repeatsExistingComment(
                    retryComment,
                    post.comments || [],
                    options.recentComments || [],
                )
                    || exposesInternalRoleLabel(retryComment)
                    || violatesPresenceClaim(retryComment, post, member)
                    ? ''
                    : retryComment;
            } else {
                comment = '';
            }
        } catch {
            comment = '';
        }
    }
    return {
        comment,
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
    const sharedScene = decision.sharedScene || null;
    const sharedSceneActive = !!sharedScene?.id
        && Array.isArray(sharedScene.participantIds)
        && sharedScene.participantIds.includes(member.avatar);
    const roomCompanionReferences = sharedSceneActive && !everydayPhoto
        ? (decision.sharedVisibleMemberIds || [])
            .filter(avatar => avatar !== member.avatar
                && sharedScene.participantIds.includes(avatar))
            .slice(0, 2)
            .map(avatar => {
                const companion = room.members.find(candidate => candidate.avatar === avatar);
                const image = companion ? readAvatar(settings, companion.avatar) : null;
                return companion && image?.data ? { companion, image } : null;
            })
            .filter(Boolean)
        : [];
    const visibleRoomMembers = roomCompanionReferences.map(item => item.companion);
    let personaReference = null;
    if (!sharedSceneActive
        && !everydayPhoto
        && persona?.avatar
        && relationAllowsCompanion(room, member, persona)) {
        personaReference = readPersonaAvatar(settings, persona.avatar);
    }
    const companionDecision = chooseCompanionSelfie({
        photoMode,
        eligible: !sharedSceneActive && !!personaReference?.data,
        chance: settings.partnerSelfieChance ?? 45,
        roll: decision.companionRoll ?? 50,
        recentCompanionFlags: decision.recentCompanionFlags || [],
    });
    const companionSelfie = companionDecision.includePersona;
    const roomCompanionSelfie = sharedSceneActive && visibleRoomMembers.length > 0;
    const roomCompanionNames = visibleRoomMembers.map(companion => companion.name);
    const sharedPreviousViews = (sharedScene?.posts || [])
        .map(post => `${post.authorName}: ${post.photoMode} / ${post.viewpoint || '관점 미상'}`)
        .slice(-4);
    const sharedSceneRule = sharedSceneActive
        ? [
            '[이번 시간대 공동 장면 — 참석자 모두에게 동일한 사실]',
            `- SCENE_ID=${sharedScene.id}`,
            `- 장소: ${sharedScene.locationEn} (${sharedScene.locationKo})`,
            `- 현장 참석자: ${sharedScene.participantNames.join(', ')}`,
            `- 모든 참석자 게시물에서 유지할 배경 기준: ${sharedScene.anchorEn}`,
            sharedScene.continuity
                ? `- 먼저 생성된 게시물이 확정한 연속성: ${sharedScene.continuity}`
                : '- 아직 먼저 생성된 게시물이 없다. 위 장소와 배경 기준을 구체화해 continuity에 기록한다.',
            sharedPreviousViews.length
                ? `- 이미 올라온 같은 장면의 관점과 겹치지 않게 한다: ${sharedPreviousViews.join(' / ')}`
                : '- 이 장면에서 첫 게시물이다.',
            '- 다른 장소나 다른 약속으로 바꾸지 않는다.',
            '- 같은 장소·조명·공유 사물은 유지하되, 게시자 성격에 맞춰 다른 구도와 다른 피사체를 고른다.',
            '- continuity에는 다음 게시물도 그대로 재사용할 장소 배치·조명·공유 사물만 영어 300자 이내로 적는다.',
            '- viewpoint에는 이번 사진만의 구도와 주 피사체를 영어 120자 이내로 적는다.',
        ].filter(Boolean).join('\n')
        : '';
    const photoModeRule = everydayPhoto
        ? [
            '[이번 게시물의 사진 유형 — 일상 사진]',
            '- 사람이 한 명도 나오지 않는 게시 캐릭터 시점의 휴대폰 사진이어야 한다.',
            '- 하늘, 거리, 음식, 커피, 책상, 작업 화면, 운동·취미 도구, 소지품, 방, 야경, 반려동물 중 캐릭터와 시간대에 자연스러운 대상을 고른다.',
            '- 셀카, 얼굴, 손을 제외한 신체, 거울 속 사람, 배경 행인처럼 식별 가능한 사람을 넣지 않는다.',
            '- personaVisible은 반드시 false, personaVisualIdentity와 visualIdentity는 빈 문자열로 둔다.',
        ].join('\n')
        : roomCompanionSelfie
            ? [
                '[이번 게시물의 사진 유형 — 같은 방 캐릭터 동반 셀카]',
                `- 게시 캐릭터(${member.name})가 직접 찍은 셀카에 ${roomCompanionNames.join(', ')}도 함께 보여야 한다.`,
                `- 사진에 보이는 사람은 정확히 ${[member.name, ...roomCompanionNames].join(', ')}이며 서로 다른 사람으로 구분한다.`,
                '- 첨부되는 각 프사를 해당 인물의 유일한 얼굴 기준으로 사용한다.',
                '- 현장에 있어도 위 목록에 없는 참석자는 이번 사진 프레임 밖에 둔다.',
                '- 제3자가 찍은 사진, 삼각대, 영화 스틸 구도는 금지한다.',
                '- personaVisible은 false이며 연결 페르소나는 이번 사진에 넣지 않는다.',
            ].join('\n')
            : sharedSceneActive
                ? [
                    '[이번 게시물의 사진 유형 — 공동 장면 속 혼자 셀카]',
                    `- 게시 캐릭터(${member.name})가 공동 장소에서 직접 찍은 셀카다.`,
                    `- 현장에는 ${sharedScene.participantNames.join(', ')}가 있지만 이번 사진에 보이는 인물은 ${member.name} 한 명뿐이다.`,
                    '- 다른 참석자와 정체를 알 수 있는 배경 인물을 프레임에 넣지 않는다.',
                    '- 연결 페르소나도 이번 사진에 넣지 않는다.',
                    '- 제3자가 찍은 사진, 삼각대, 영화 스틸 구도는 금지한다.',
                    '- personaVisible은 false다.',
                ].join('\n')
        : companionSelfie
            ? [
                '[이번 게시물의 사진 유형 — 연결 페르소나 동반 셀카]',
                `- 게시 캐릭터(${member.name})가 직접 찍은 셀카에 연결 페르소나(${personaName})도 함께 보여야 한다.`,
                `- 두 사람의 얼굴과 신체를 합치지 말고 ${member.name}와 ${personaName}를 서로 다른 두 사람으로 선명하게 구분한다.`,
                `- scene에 반드시 "${member.name} taking a smartphone selfie together with ${personaName}"를 명시한다.`,
                '- 제3자가 찍어준 사진, 멀리서 찍힌 전신 사진, 몰래 찍은 사진, 감시 카메라, 삼각대, 영화 스틸 같은 구도는 금지한다.',
                '- personaVisible은 반드시 true로 하고 personaVisualIdentity를 채운다.',
                '- 관계는 최근 대화와 저장된 관계에 있는 만큼만 표현하며, 새로운 관계를 만들어내지 않는다.',
            ].join('\n')
            : [
            '[이번 게시물의 사진 유형 — 셀카]',
            `- 게시 캐릭터(${member.name})가 직접 찍은 전면 카메라 셀카, 팔을 뻗은 셀카 또는 거울 셀카여야 한다.`,
            `- 이번에는 ${member.name}만 나오며 연결 페르소나나 다른 식별 가능한 사람을 넣지 않는다.`,
            '- 제3자가 찍어준 사진, 멀리서 찍힌 전신 사진, 몰래 찍은 사진, 감시 카메라, 삼각대, 영화 스틸 같은 구도는 금지한다.',
            `- scene에 반드시 "front-facing smartphone selfie taken by ${member.name}" 또는 "mirror selfie taken by ${member.name}"를 명시한다.`,
            '- personaVisible은 반드시 false, personaVisualIdentity는 빈 문자열로 둔다.',
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
        '{"post": true 또는 false, "caption": "캐릭터 시점의 25자 이내 SNS 캡션", "scene": "사진 장면을 영어로 묘사", "continuity": "같은 장면의 다음 게시물도 유지할 장소·조명·공유 사물을 영어 300자 이내", "viewpoint": "이번 사진의 고유 구도와 주 피사체를 영어 120자 이내", "visualIdentity": "게시 캐릭터의 눈에 보이는 외형만 영어 200자 이내", "personaVisible": true 또는 false, "personaVisualIdentity": "페르소나가 보일 때 페르소나의 눈에 보이는 외형만 영어 200자 이내", "roleCheck": "각 인물이 무엇을 하는지 짧게 확인"}',
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
        '- post가 true면 visualIdentity에는 캐릭터 카드에서 확인되는 성별, 대략적 나이, 머리, 얼굴, 체격처럼 사진에 필요한 고정 외형과 이번 장소·활동·계절에 맞는 현재 옷차림만 짧게 쓴다.',
        '- 캐릭터 프사는 얼굴과 고정 외형의 참고 자료일 뿐이다. 프사에 보이는 옷, 노출 정도, 포즈, 행동, 배경을 현재 장면으로 복사하지 마라.',
        '- 카페·식당·상점·학교 실내·도서관·사무실·대중교통 같은 일반적인 공공장소에서는 모든 인물에게 정상적인 상의를 반드시 입힌다.',
        '- 그 밖의 장소에서는 현재 활동, 사생활 정도, 날씨, 계절, 안전과 캐릭터 성격에 맞춰 옷차림을 자연스럽게 결정한다. 프사에 보이는 옷이나 노출 정도를 그대로 복사하지 마라.',
        '- visualIdentity에 성격, 관계, 과거사, 직업 설명, 유저 정보, 신체 상태에 관한 추측을 넣지 마라.',
        companionSelfie
            ? `- 이번 사진에는 연결 페르소나(${personaName})가 반드시 보인다. personaVisible은 true다.`
            : `- 이번 사진에는 연결 페르소나(${personaName})가 보이지 않는다. personaVisible은 false다.`,
        `- personaVisible이 true면 personaVisualIdentity에는 유저 페르소나 설명에서 확인되는 외형과 계절에 맞는 현재 옷차림만 쓴다. 캐릭터(${member.name})의 외형과 섞지 마라.`,
        '- personaVisible이 false면 personaVisualIdentity는 빈 문자열로 둔다.',
        '',
        sharedSceneRule,
        sharedSceneRule ? '' : '',
        photoModeRule,
        '',
        'post가 true일 때 scene 규칙:',
        '- 캐릭터 카드에 적힌 직업, 취미, 성격, 생활 방식과 최근 관계 상황이 자연스럽게 함께 드러나는 일상을 만든다.',
        '- 최근 대화의 사건을 그대로 복사할 필요는 없지만, 지금 관계 때문에 캐릭터가 실제로 할 법한 선택과 행동은 반영한다.',
        '- 이 시각에 이 캐릭터가 실제로 있을 법한 곳, 실제로 보고 있을 법한 것.',
        `- scene은 사진을 올리는 사람이 "${member.name}"임을 전제로 쓴다. 인물이 나오면 이름 또는 "the male character", "his partner"처럼 역할을 명확히 적는다.`,
        '- 장면의 모든 행동·직업·신체 상태가 누구의 것인지 roleCheck로 마지막 검증한다. 서로 뒤바뀌었으면 고쳐서 출력한다.',
        '- caption도 캐릭터가 직접 쓴 말이어야 하며, 유저가 쓴 것처럼 시점을 바꾸지 마라.',
        '- caption에는 내부 역할표시인 "유저", "user", "페르소나", "persona"를 호칭처럼 쓰지 않는다. 실제 이름이나 관계에 맞는 호칭만 쓴다.',
        '- 폰으로 방금 대충 찍어 바로 올린 스냅이어야 한다. 구도가 조금 어긋나도 좋다.',
        '- 조명·장소·사물을 구체적으로. 추상적 표현 금지.',
        '- scene에 등장하는 모든 인물의 복장은 프사보다 현재 장소와 활동을 우선한다. 공공장소에 어울리지 않는 옷차림이 생성되려 하면 장소에 맞는 옷으로 고쳐서 출력한다.',
        `- 현재 달력과 시간대는 ${temporal.label}, ${timeLabel(slotAt)}이다. 장면과 caption의 아침·낮·저녁·밤 표현을 반드시 이 시각에 맞춘다.`,
        `- 이미지 조명 규칙: ${temporal.lightingEn}`,
        `- 장면의 옷차림, 자연광의 길이와 색, 식생과 주변 환경을 ${temporal.seasonKo}에 자연스럽게 맞춘다.`,
        '- 계절만 보고 비·눈·폭염 같은 정확한 날씨를 임의로 만들지는 마라.',
        '- 장면에 명시된 지역이 남반구·열대이거나 실내 환경이라면 그 지역과 장소의 조건을 계절 일반값보다 우선한다.',
    ].filter(Boolean).join('\n');

    const user = [
        `현재 날짜와 시각은 ${temporal.label}, ${timeLabel(slotAt)}이다.`,
        `이번 랜덤 게시 충동은 ${decision.randomRoll ?? 50}/99이다.`,
        `이번 사진 유형은 ${everydayPhoto
            ? sharedSceneActive ? `공동 장면(${sharedScene.locationKo})의 사람 없는 일상 사진` : '사람 없는 일상 사진'
            : roomCompanionSelfie
                ? `같은 방 캐릭터 ${roomCompanionNames.join(', ')}와 함께 찍는 셀카`
                : sharedSceneActive
                    ? `공동 장면(${sharedScene.locationKo})에서 혼자 찍는 셀카`
                    : companionSelfie ? `연결 페르소나 ${personaName}와 함께 찍는 셀카` : '혼자 찍는 셀카'}로 이미 결정됐다. 다른 유형으로 바꾸지 마라.`,
        `설정한 셀카 기본 비율은 ${decision.baseSelfieChance ?? 50}%이며 캐릭터 카드 보정 후 ${decision.selfieChance ?? 50}%다.${decision.forcedOpposite ? ` 설정 비율에 따른 같은 유형 연속 한도 ${decision.streakLimit}회에 도달해 이번에는 반대 유형으로 강제됐다. 반드시 강제된 유형을 지킨다.` : ''}`,
        !everydayPhoto && !sharedSceneActive
            ? `셀카 중 연결 페르소나 동반 설정은 ${companionDecision.chance}%다.${companionDecision.forcedOpposite ? ` 설정 비율에 따른 ${companionDecision.forcedFrom ? '동반' : '혼자'} 셀카 연속 한도 ${companionDecision.streakLimit}회에 도달해 이번에는 반대 구성으로 강제됐다.` : ''}`
            : '',
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

    const characterPerson = {
        kind: 'character',
        id: member.avatar,
        name: member.name,
        avatar: member.avatar,
    };
    const sceneParticipantPeople = sharedSceneActive
        ? sharedScene.participantIds
            .map(avatar => room.members.find(candidate => candidate.avatar === avatar))
            .filter(Boolean)
            .map(candidate => ({
                kind: 'character',
                id: candidate.avatar,
                name: candidate.name,
                avatar: candidate.avatar,
            }))
        : [];
    const visibleRoomPeople = visibleRoomMembers.map(candidate => ({
        kind: 'character',
        id: candidate.avatar,
        name: candidate.name,
        avatar: candidate.avatar,
    }));
    const personaPerson = companionSelfie
        ? {
            kind: 'persona',
            id: `persona:${String(persona.avatar || personaName).trim()}`,
            name: personaName,
            avatar: persona.avatar || null,
        }
        : null;
    const presentPeople = sharedSceneActive
        ? sceneParticipantPeople
        : [characterPerson, ...(personaPerson ? [personaPerson] : [])];
    const visiblePeople = everydayPhoto
        ? []
        : [
            characterPerson,
            ...visibleRoomPeople,
            ...(personaPerson ? [personaPerson] : []),
        ];

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
            if (roomCompanionSelfie) {
                for (const item of roomCompanionReferences) {
                    references.push({
                        role: 'room character',
                        name: item.companion.name,
                        image: item.image,
                    });
                }
            } else if (companionSelfie) {
                references.push({
                    role: 'user persona',
                    name: personaName,
                    image: personaReference,
                });
            }
            const sceneParts = [];
            if (sharedSceneActive) {
                sceneParts.push(
                    `This is the same shared scene at ${sharedScene.locationEn}.`,
                    `Keep this fixed background and spatial anchor: ${sharedScene.anchorEn}.`,
                    sharedScene.continuity
                        ? `Match this already established continuity exactly: ${sharedScene.continuity}.`
                        : '',
                );
            }
            sceneParts.push(parsed.scene);
            if (roomCompanionSelfie) {
                sceneParts.push(
                    `The visible people are exactly ${[member.name, ...roomCompanionNames].join(', ')} as separate people.`,
                    'Every other attendee remains outside the frame.',
                );
            } else if (companionSelfie) {
                sceneParts.push(
                    `Both ${member.name} and ${personaName} must be visibly present as two separate people in the selfie.`,
                );
            } else if (!everydayPhoto) {
                sceneParts.push(`Only ${member.name} is visible in the selfie.`);
            }
            const scene = sceneParts.filter(Boolean).join(' ');
            const identityEntities = everydayPhoto
                ? []
                : [
                    member,
                    ...visibleRoomMembers,
                    ...(companionSelfie ? [persona] : []),
                ];
            image = await generateImage(
                settings,
                scene,
                references,
                member,
                companionSelfie ? persona : null,
                parsed.visualIdentity,
                companionSelfie ? parsed.personaVisualIdentity : '',
                `${temporal.label} (${temporal.seasonEn}), ${timeLabel(slotAt)}, ${temporal.daypartEn}. ${temporal.lightingEn}`,
                photoMode,
                identityEntities,
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
        withPersona: companionSelfie,
        companionName: companionSelfie ? personaName : null,
        sceneContinuity: sharedSceneActive
            ? String(parsed.continuity
                || sharedScene.continuity
                || `${sharedScene.locationEn}; ${sharedScene.anchorEn}`).slice(0, 500)
            : '',
        sceneViewpoint: sharedSceneActive
            ? String(parsed.viewpoint || parsed.scene || '').slice(0, 160)
            : '',
        presentPeople,
        visiblePeople,
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
    const parts = [];
    for (const [index, reference] of normalizeReferences(references).entries()) {
        const neutralLabel = index === 0
            ? 'Person A — the posting character'
            : `Person ${String.fromCharCode(65 + index)} — a separate companion`;
        parts.push({
            text: [
                `Reference image ${index + 1}: ${neutralLabel}.`,
                'This reference image is the sole visual identity source for this person.',
                'Copy the same face and visible identity from the reference pixels; do not infer appearance from a name, fictional canon, film, actor, celebrity, franchise, adaptation, or general training-data association.',
                'Use the reference for identity only. Do not copy its clothing, amount of exposed skin, pose, activity, setting, lighting or background.',
                'Wardrobe must be chosen from the requested scene, location, season and activity, even when it differs completely from the reference image.',
                'Keep this person distinct from every other reference.',
            ].join(' '),
        });
        parts.push({
            inline_data: {
                mime_type: reference.image.mime,
                data: reference.image.data,
            },
        });
    }
    // 참조 이미지와 정체성 지시를 장면 프롬프트보다 먼저 전달해, 유명 이름이나
    // 배경 설정보다 프사의 얼굴을 우선하도록 한다.
    parts.push({ text: prompt });
    return callVertexProfile(api, {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['Image'],
        },
    });
}

function replaceLiteralIgnoreCase(text, search, replacement) {
    const needle = String(search || '').trim();
    if (!needle) return text;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text || '').replace(new RegExp(escaped, 'giu'), replacement);
}

function identityNameVariants(name) {
    const full = String(name || '').trim();
    if (!full) return [];
    const first = full.split(/\s+/u)[0] || '';
    return [...new Set([
        full,
        first.length >= 3 ? first : '',
    ].filter(Boolean))].sort((a, b) => b.length - a.length);
}

function neutralizeIdentityNames(scene, member, persona, identityEntities = []) {
    let neutral = String(scene || '');
    const entities = identityEntities.length
        ? identityEntities
        : [member, persona].filter(Boolean);
    for (const [index, entity] of entities.entries()) {
        const label = `Person ${String.fromCharCode(65 + index)}`;
        for (const name of identityNameVariants(entity?.name)) {
            neutral = replaceLiteralIgnoreCase(neutral, name, label);
        }
    }
    return neutral;
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
    identityEntities = [],
) {
    const imageApi = resolveImageApi(settings);

    const usableReferences = normalizeReferences(references);
    const everydayPhoto = photoMode === 'everyday';
    const hasCompanionReference = usableReferences.length > 1;
    if (!everydayPhoto
        && !usableReferences.some(reference => reference.role === 'posting character')) {
        throw new Error('게시 캐릭터 참조 프사가 없어 인물 사진 생성을 건너뜀');
    }
    // 인물 이름이 유명 캐릭터·배우의 학습 외형을 불러오지 않도록 실제 이미지
    // 요청에서는 이름을 중립 라벨로 바꾼다. 얼굴·머리·나이·체격은 첨부 프사만
    // 기준으로 하며, 텍스트 모델이 만든 visualIdentity는 장면 판단에만 사용한다.
    const neutralScene = neutralizeIdentityNames(
        scene,
        member,
        persona,
        identityEntities,
    );
    const companionIdentityLocks = usableReferences.slice(1)
        .map((reference, offset) => {
            const personLabel = `Person ${String.fromCharCode(66 + offset)}`;
            return `${personLabel} must be the exact separate person shown in Reference image ${offset + 2}. Reference image ${offset + 2} is the sole visual identity source for ${personLabel}, but it is not a wardrobe, pose, activity or background reference.`;
        });
    const allReferenceLabels = usableReferences
        .map((_, index) => `Person ${String.fromCharCode(65 + index)}`);
    const identityRule = everydayPhoto
        ? 'The photographer and every other person must remain completely out of frame. Do not generate a face, body, reflection, selfie, portrait, crowd, or identifiable bystander.'
        : [
            'STRICT REFERENCE-ONLY IDENTITY LOCK.',
            'Person A is the posting character and must be the exact person shown in Reference image 1.',
            'Reference image 1 is the sole and mandatory source for Person A’s face, facial proportions, eyes, nose, mouth, jaw, hair, apparent age, skin tone and build.',
            'Reference image 1 is not a wardrobe reference. Ignore its clothing, amount of exposed skin, pose, activity, setting, lighting and background.',
            'Ignore every visual association learned from character names, fictional canon, books, films, television, actors, celebrities, franchises, adaptations or fandom artwork.',
            'Do not render a canonical version, screen adaptation, actor, celebrity, lookalike or alternate interpretation of Person A.',
            'Names in the scene are role labels only and have been intentionally replaced with neutral labels. Never use a name to decide appearance.',
            ...companionIdentityLocks,
            hasCompanionReference
                ? `Never merge ${allReferenceLabels.join(', ')}, exchange their faces, or transfer one person’s appearance to another.`
                : '',
        ].filter(Boolean).join(' ');
    const cameraRule = everydayPhoto
        ? 'Create a first-person rear-camera phone snapshot of ordinary daily life: scenery, sky, food, drink, desk, hobby equipment, belongings, room, street, night view, or a pet. No people or human reflections may appear.'
        : hasCompanionReference
            ? `Make it a believable front-facing smartphone selfie, arm’s-length selfie, or mirror selfie taken by Person A. Exactly ${allReferenceLabels.join(', ')} must be visible together as distinct people. Never add an unreferenced identifiable person or use a third-person camera.`
            : 'Make it a believable front-facing smartphone selfie, arm’s-length selfie, or mirror selfie taken by Person A. Only Person A may be visible. Never use a third-person, candid observer, tripod, surveillance, cinematic, or someone-else-took-it angle.';
    const seasonRule = temporalContext
        ? `Calendar context: ${temporalContext}. Match clothing, daylight, vegetation and surroundings to this date, season and time. Do not invent rain, snow or extreme weather from the season alone. If the described location has a different climate or the scene is indoors, follow the actual location and environment instead.`
        : '';
    const attireRule = everydayPhoto
        ? ''
        : [
            'SCENE-APPROPRIATE WARDROBE OVERRIDES REFERENCE WARDROBE.',
            'Dress every visible person for the requested place, activity, season and time; never copy an undressed or minimally dressed state merely because it appears in a reference image.',
            'In ordinary public places such as cafes, restaurants, shops, indoor school areas, libraries, offices and public transit, every visible person must wear a normal complete top and socially appropriate public clothing.',
            'Outside those ordinary public settings, choose clothing naturally from the current activity, level of privacy, weather, season, safety and character behavior without forcing either a dressed or undressed state.',
            'Never copy the wardrobe or amount of exposed skin from a reference image. If the scene wording and the reference wardrobe conflict, follow the scene.',
        ].join(' ');
    const qualityRule = 'Create the image now as a casual phone snapshot taken moments ago for an immediate social post. Natural available light, slightly imperfect framing, no text, no watermark.';
    const fullPrompt = `${neutralScene}. ${identityRule} ${seasonRule} ${attireRule} ${cameraRule} ${qualityRule}`;
    const compactPrompt = everydayPhoto
        ? `${neutralScene}. ${identityRule} ${seasonRule} Generate a casual rear-camera phone snapshot of daily life with absolutely no people. No text or watermark.`
        : `${neutralScene}. ${identityRule} ${seasonRule} ${attireRule} Generate a casual phone selfie taken by Person A. No text or watermark.`;
    const recoveryPrompt = everydayPhoto
        ? `${neutralScene}. Generate a fresh casual rear-camera phone snapshot. No person, face, body, human reflection, text or watermark. ${seasonRule}`
        : [
            `${neutralScene}. Generate a fresh casual smartphone selfie from scratch.`,
            'IDENTITY IS MORE IMPORTANT THAN STYLE OR CANON.',
            'Person A must match Reference image 1 exactly and must not resemble any actor, celebrity, official adaptation or famous fictional-character depiction.',
            hasCompanionReference
                ? `${companionIdentityLocks.join(' ')} Keep every referenced face distinct.`
                : 'Only Person A may be visible.',
            attireRule,
            cameraRule,
            seasonRule,
            'No text or watermark.',
        ].filter(Boolean).join(' ');
    const attemptLabel = everydayPhoto ? '일상사진' : '인물 참조';
    const attempts = [
        { label: `${attemptLabel}+전체 프롬프트`, prompt: fullPrompt, references: usableReferences },
        { label: `${attemptLabel}+간단 프롬프트`, prompt: compactPrompt, references: usableReferences },
        { label: `${attemptLabel}+추가 재생성`, prompt: recoveryPrompt, references: usableReferences },
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

    if (typeof inline.data !== 'string'
        || !/^[a-z0-9+/]+={0,2}$/i.test(inline.data)
        || inline.data.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4) {
        throw new Error('생성 이미지 데이터 형식이 올바르지 않습니다');
    }
    const generatedBuffer = Buffer.from(inline.data, 'base64');
    if (generatedBuffer.length < 12 || generatedBuffer.length > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error('생성 이미지 크기가 허용 범위를 벗어났습니다');
    }
    const generatedType = detectImageType(generatedBuffer);
    if (!generatedType || !['png', 'jpg', 'webp'].includes(generatedType.ext)) {
        throw new Error('생성 이미지의 실제 파일 형식을 확인할 수 없습니다');
    }

    const dir = path.join(PUBLIC_ROOT, 'user', 'images', 'chatlog');
    fs.mkdirSync(dir, { recursive: true });
    const dirStat = fs.lstatSync(dir);
    const realPublicRoot = fs.realpathSync(PUBLIC_ROOT);
    const realDir = fs.realpathSync(dir);
    if (!dirStat.isDirectory()
        || dirStat.isSymbolicLink()
        || !isPathInside(realPublicRoot, realDir)) {
        throw new Error('챗로그 이미지 저장 폴더가 안전하지 않습니다');
    }
    const filename = `cut_${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${generatedType.ext}`;
    fs.writeFileSync(path.join(realDir, filename), generatedBuffer, { flag: 'wx', mode: 0o600 });

    return `/user/images/chatlog/${filename}`;
}

module.exports = {
    safeUserHandle,
    userDataDir,
    normalizeVertexRegion,
    assertGoogleVertexUrl,
    resolveProfileApi,
    activeProfileName,
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
    setDebugEnabled,
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
    ratioAwareRunLimit,
    consecutiveRun,
    ratioBalancedChance,
    choosePhotoMode,
    chooseCompanionSelfie,
    relationAllowsCompanion,
    chatPersonaScore,
    characterRelationshipBlock,
    displayPersona,
    samePersona,
    postAuthorName,
    normalizeRelationshipGraph,
    mergeRelationshipGraphs,
    relationshipGraphBlock,
    analyzeRoomRelationships,
    repeatsExistingComment,
    postPresenceRules,
    violatesPresenceClaim,
};
