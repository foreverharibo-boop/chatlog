#!/data/data/com.termux/files/usr/bin/bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

find_st_root() {
    if [ "${1:-}" != "" ]; then
        CDPATH= cd -- "$1" 2>/dev/null && pwd
        return
    fi
    if [ -f "$HOME/SillyTavern/server.js" ]; then
        printf '%s\n' "$HOME/SillyTavern"
        return
    fi
    candidate="$SCRIPT_DIR"
    while [ "$candidate" != "/" ]; do
        if [ -f "$candidate/server.js" ] && [ -d "$candidate/plugins" ]; then
            printf '%s\n' "$candidate"
            return
        fi
        candidate="$(dirname -- "$candidate")"
    done
    return 1
}

ST_ROOT="$(find_st_root "${1:-}")" || {
    printf 'SillyTavern 폴더를 찾지 못했습니다.\n'
    printf '예: bash install-termux.sh ~/SillyTavern\n'
    exit 1
}

SOURCE="$SCRIPT_DIR/server"
TARGET="$ST_ROOT/plugins/chatlog"
CONFIG="$ST_ROOT/config.yaml"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
BACKUP_ROOT="$ST_ROOT/chatlog-backups/$STAMP"
PLUGIN_BACKUP="$BACKUP_ROOT/server"
CONFIG_BACKUP="$BACKUP_ROOT/config.yaml"

if [ ! -f "$ST_ROOT/server.js" ] || [ ! -f "$SOURCE/index.js" ] || [ ! -f "$SOURCE/paths.js" ]; then
    printf 'SillyTavern 또는 챗로그 서버 파일을 확인할 수 없습니다.\n'
    exit 1
fi
if [ ! -f "$CONFIG" ]; then
    printf 'config.yaml이 없습니다. SillyTavern을 한 번 실행한 뒤 다시 시도하세요.\n'
    exit 1
fi

printf '\n챗로그 자동 게시 기능은 SillyTavern 서버 플러그인을 사용합니다.\n'
printf '서버 플러그인은 일반 확장보다 권한이 크므로 신뢰하는 플러그인만 설치해야 합니다.\n'
printf '기존 챗로그 데이터와 설정은 보존하고, 기존 서버 폴더는 백업합니다.\n\n'
printf '중요: 먼저 실행 중인 SillyTavern을 Ctrl+C로 완전히 종료하세요.\n'
printf 'SillyTavern 위치: %s\n' "$ST_ROOT"
printf '계속할까요? [y/N] '
read -r answer
case "$answer" in
    y|Y|yes|YES) ;;
    *) printf '설치를 취소했습니다.\n'; exit 0 ;;
esac

mkdir -p "$ST_ROOT/plugins"
mkdir -p "$BACKUP_ROOT"

if [ -L "$TARGET" ]; then
    current_target="$(readlink -f "$TARGET" 2>/dev/null || true)"
    source_target="$(readlink -f "$SOURCE" 2>/dev/null || printf '%s' "$SOURCE")"
    if [ "$current_target" != "$source_target" ]; then
        previous_link="$(readlink "$TARGET")"
        if [ -d "$TARGET" ]; then
            for runtime_file in data.json settings.json; do
                if [ -f "$TARGET/$runtime_file" ]; then
                    cp -p "$TARGET/$runtime_file" "$SOURCE/$runtime_file"
                fi
            done
        fi
        printf '%s\n' "$previous_link" > "$BACKUP_ROOT/previous-server-link.txt"
        rm "$TARGET"
        if ! ln -s "$SOURCE" "$TARGET"; then
            rm -f "$TARGET"
            ln -s "$previous_link" "$TARGET"
            printf '바로가기 생성에 실패해 기존 연결을 복구했습니다.\n'
            exit 1
        fi
        printf '기존 서버 연결 정보를 plugins 밖에 백업하고 새로 연결했습니다: %s\n' "$BACKUP_ROOT"
    else
        printf '서버 바로가기는 이미 정상입니다.\n'
    fi
elif [ -e "$TARGET" ]; then
    for runtime_file in data.json settings.json; do
        if [ -f "$TARGET/$runtime_file" ]; then
            cp -p "$TARGET/$runtime_file" "$SOURCE/$runtime_file"
        fi
    done
    mv "$TARGET" "$PLUGIN_BACKUP"
    if ! ln -s "$SOURCE" "$TARGET"; then
        mv "$PLUGIN_BACKUP" "$TARGET"
        printf '바로가기 생성에 실패해 기존 서버 폴더를 복구했습니다.\n'
        exit 1
    fi
    printf '기존 서버 폴더를 백업했습니다: %s\n' "$PLUGIN_BACKUP"
else
    if ! ln -s "$SOURCE" "$TARGET"; then
        printf '바로가기 생성에 실패했습니다. 기존 파일은 변경하지 않았습니다.\n'
        exit 1
    fi
    printf '챗로그 서버 바로가기를 만들었습니다.\n'
fi

cp -p "$CONFIG" "$CONFIG_BACKUP"
if grep -Eq '^[[:space:]]*enableServerPlugins:' "$CONFIG"; then
    sed -i -E 's/^([[:space:]]*)enableServerPlugins:[[:space:]]*.*/\1enableServerPlugins: true/' "$CONFIG"
else
    printf '\nenableServerPlugins: true\n' >> "$CONFIG"
fi

node --check "$SOURCE/index.js"
node --check "$SOURCE/ai.js"
node --check "$SOURCE/paths.js"

printf '\n설치가 완료되었습니다.\n'
printf '챗로그 설치 백업: %s\n' "$BACKUP_ROOT"
printf '이제 SillyTavern을 완전히 종료한 뒤 다시 실행하세요:\n'
printf '  cd "%s" && npm start\n' "$ST_ROOT"
