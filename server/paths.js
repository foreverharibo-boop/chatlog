/**
 * SillyTavern 루트 탐색.
 *
 * 서버 플러그인이 확장 폴더의 server 디렉터리를 가리키는 심볼릭 링크로
 * 설치되면 Node의 __dirname은 링크 위치가 아니라 실제 확장 위치가 된다.
 * 따라서 __dirname/../.. 같은 고정 상대 경로 대신 server.js가 있는 루트를
 * 실행 위치와 진입 파일 위치에서 위로 올라가며 찾는다.
 */

const fs = require('fs');
const path = require('path');

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function isSillyTavernRoot(candidate) {
    if (!candidate) return false;
    try {
        return fs.statSync(path.join(candidate, 'server.js')).isFile()
            && isDirectory(path.join(candidate, 'data'))
            && isDirectory(path.join(candidate, 'public'))
            && isDirectory(path.join(candidate, 'plugins'));
    } catch {
        return false;
    }
}

function walkUpForRoot(start) {
    if (!start) return null;
    let current = path.resolve(start);
    try {
        if (fs.statSync(current).isFile()) current = path.dirname(current);
    } catch {
        return null;
    }

    while (true) {
        if (isSillyTavernRoot(current)) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function findSillyTavernRoot() {
    const entryFile = require.main?.filename || process.argv[1] || '';
    const starts = [
        process.env.CHATLOG_ST_ROOT,
        process.env.SILLY_TAVERN_ROOT,
        process.cwd(),
        entryFile ? path.dirname(entryFile) : '',
        __dirname,
    ].filter(Boolean);

    const checked = new Set();
    for (const start of starts) {
        const normalized = path.resolve(start);
        if (checked.has(normalized)) continue;
        checked.add(normalized);
        const found = walkUpForRoot(normalized);
        if (found) return found;
    }

    throw new Error(
        'SillyTavern 루트를 찾을 수 없습니다. server.js가 있는 폴더에서 SillyTavern을 실행하세요.',
    );
}

module.exports = {
    findSillyTavernRoot,
    isSillyTavernRoot,
    walkUpForRoot,
};
