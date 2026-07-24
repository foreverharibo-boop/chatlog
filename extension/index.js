/**
 * 챗로그 클라이언트 확장
 * 배치: SillyTavern/public/scripts/extensions/third-party/chatlog/
 */

const API = '/api/plugins/chatlog';

// ── 유틸 ──────────────────────────────────────────────────
const ctx = () => window.SillyTavern?.getContext?.() || {};
const headers = () => { try { return ctx().getRequestHeaders?.() || {}; } catch { return {}; } };

async function api(pathname, body) {
    const opts = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(body) }
        : { headers: headers() };
    const res = await fetch(API + pathname, opts);
    if (!res.ok) throw new Error(`${pathname} ${res.status}`);
    return res.json();
}

const esc = (s) => $('<div>').text(s ?? '').html();

function timeLabel(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function avatarUrl(avatar) {
    return avatar === 'user'
        ? (ctx().userAvatar ? `/User Avatars/${ctx().userAvatar}` : '/img/user-default.png')
        : `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
}

// ── 상태 ──────────────────────────────────────────────────
let state = { rooms: {}, posts: {} };
let view = { screen: 'rooms', roomId: null };
let defaultSchedule = { activeFrom: 8, activeTo: 24, cutIntervalHours: 2, jitter: true };

// ═══════════ 확장 탭 설정 ═══════════
const SETTINGS_HTML = `
<div class="chatlog-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>챗로그</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label for="chatlog-profile">연결 프로필 (텍스트)</label>
      <select id="chatlog-profile" class="text_pole"></select>
      <small>서버가 이 프로필의 모델·키를 직접 읽어서 씁니다.</small>

      <label for="chatlog-image-key">이미지 생성 API 키</label>
      <input id="chatlog-image-key" type="password" class="text_pole" placeholder="이미지 전용 키">

      <label for="chatlog-image-model">이미지 모델</label>
      <input id="chatlog-image-model" type="text" class="text_pole">

      <hr>
      <label>활동 시간대</label>
      <div class="chatlog-row">
        <input id="chatlog-active-from" type="number" min="0" max="23" class="text_pole">
        <span>시 ~</span>
        <input id="chatlog-active-to" type="number" min="1" max="24" class="text_pole">
        <span>시</span>
      </div>
      <small>이 시간 밖에서는 캐릭터가 아무것도 올리지 않습니다.</small>

      <label for="chatlog-interval">캐릭터 업로드 간격 (시간)</label>
      <input id="chatlog-interval" type="number" min="1" max="24" class="text_pole">
      <small id="chatlog-cost">비용 안내</small>

      <label class="checkbox_label">
        <input id="chatlog-jitter" type="checkbox"><span>간격 흔들기 (±25%)</span>
      </label>

      <hr>
      <label>댓글 지연 (분)</label>
      <div class="chatlog-row">
        <input id="chatlog-delay-min" type="number" min="0" max="600" class="text_pole">
        <span>~</span>
        <input id="chatlog-delay-max" type="number" min="1" max="600" class="text_pole">
      </div>

      <div class="chatlog-row chatlog-actions">
        <div id="chatlog-save" class="menu_button">저장</div>
        <div id="chatlog-open" class="menu_button">챗로그 열기</div>
      </div>
    </div>
  </div>
</div>`;

async function loadSettingsUi() {
    const s = await api('/settings');
    const profiles = ctx()?.extensionSettings?.connectionManager?.profiles || [];
    const $sel = $('#chatlog-profile').empty().append('<option value="">-- 선택 --</option>');
    profiles.forEach(p => $sel.append($('<option>').val(p.name).text(p.name)));
    $sel.val(s.profileName || '');

    $('#chatlog-image-key').val(s.imageApiKey || '');
    $('#chatlog-image-model').val(s.imageModel || '');
    $('#chatlog-delay-min').val(s.commentDelayMinMin);
    $('#chatlog-delay-max').val(s.commentDelayMaxMin);

    defaultSchedule = JSON.parse(localStorage.getItem('chatlog_schedule') || 'null') || defaultSchedule;
    $('#chatlog-active-from').val(defaultSchedule.activeFrom);
    $('#chatlog-active-to').val(defaultSchedule.activeTo);
    $('#chatlog-interval').val(defaultSchedule.cutIntervalHours);
    $('#chatlog-jitter').prop('checked', defaultSchedule.jitter);
    updateCostHint();
}

function updateCostHint() {
    const from = Number($('#chatlog-active-from').val()) || 8;
    const to = Number($('#chatlog-active-to').val()) || 24;
    const iv = Number($('#chatlog-interval').val()) || 2;
    const slots = Math.max(0, Math.floor((to - from) / iv));
    $('#chatlog-cost').text(`하루 약 ${slots}슬롯 → 방 인원 1명당 이미지 ${slots}장/일.`);
}

async function saveSettingsUi() {
    defaultSchedule = {
        activeFrom: Number($('#chatlog-active-from').val()),
        activeTo: Number($('#chatlog-active-to').val()),
        cutIntervalHours: Number($('#chatlog-interval').val()),
        jitter: $('#chatlog-jitter').is(':checked'),
    };
    localStorage.setItem('chatlog_schedule', JSON.stringify(defaultSchedule));

    await api('/settings', {
        profileName: $('#chatlog-profile').val(),
        imageApiKey: $('#chatlog-image-key').val(),
        imageModel: $('#chatlog-image-model').val(),
        commentDelayMinMin: Number($('#chatlog-delay-min').val()),
        commentDelayMaxMin: Number($('#chatlog-delay-max').val()),
        userPersonaName: ctx().name1 || '',
    });

    const { rooms } = await api('/state');
    for (const room of Object.values(rooms)) {
        await api('/room/update', { roomId: room.id, schedule: defaultSchedule });
    }
    toastr?.success?.('챗로그 설정 저장됨');
}

// ═══════════ 오버레이 ═══════════
let $overlay = null;

function openChatlog() {
    closeChatlog();
    $overlay = $(`
      <div class="chatlog-overlay">
        <div class="chatlog-app">
          <header class="chatlog-head">
            <span class="chatlog-back fa-solid fa-chevron-left"></span>
            <span class="chatlog-title">chatlog</span>
            <span class="chatlog-close fa-solid fa-xmark"></span>
          </header>
          <main class="chatlog-body"></main>
        </div>
      </div>`);

    // MovingUI가 body에 transform을 걸어 fixed를 깨뜨리므로 <html>에 직접 붙인다.
    document.documentElement.appendChild($overlay[0]);

    $overlay.on('click', e => { if (e.target === $overlay[0]) closeChatlog(); });
    $overlay.find('.chatlog-close').on('click', closeChatlog);
    $overlay.find('.chatlog-back').on('click', () => { view.screen = 'rooms'; render(); });

    view = { screen: 'rooms', roomId: null };
    refresh();
}

function closeChatlog() { $overlay?.remove(); $overlay = null; }

async function refresh() {
    try {
        state = await api('/state');
    } catch (e) {
        $('.chatlog-body').html(`<div class="chatlog-empty">불러오기 실패<br><small>${esc(e.message)}</small></div>`);
        return;
    }
    render();
}

function render() {
    if (!$overlay) return;
    $overlay.find('.chatlog-back').toggleClass('hidden', view.screen === 'rooms');
    view.screen === 'rooms' ? renderRooms() : renderFeed();
}

// ── 로그 목록 ─────────────────────────────────────────────
function renderRooms() {
    const $b = $('.chatlog-body').empty();
    $('.chatlog-title').text('chatlog');

    const rooms = Object.values(state.rooms);
    if (!rooms.length) {
        $b.append('<div class="chatlog-empty">아직 로그가 없어요.<br><small>아래에서 새 로그를 만들어보세요.</small></div>');
    }

    for (const room of rooms) {
        const posts = state.posts[room.id] || [];
        const last = posts[posts.length - 1];
        const unread = posts.reduce((n, p) => n + (p.read ? 0 : 1) + p.comments.filter(c => !c.read).length, 0);

        const $card = $(`
          <div class="chatlog-roomcard">
            <div class="chatlog-roomthumb">${last?.image ? `<img src="${esc(last.image)}">` : '<span class="fa-solid fa-camera"></span>'}</div>
            <div class="chatlog-roommeta">
              <div class="chatlog-roomname">${esc(room.name)}</div>
              <div class="chatlog-roomsub">${room.members.length}명 · ${last ? timeLabel(last.createdAt) : '기록 없음'}</div>
            </div>
            ${unread ? `<span class="chatlog-badge">${unread}</span>` : ''}
          </div>`);
        $card.on('click', () => { view = { screen: 'feed', roomId: room.id }; render(); markRead(room.id); });
        $b.append($card);
    }

    const $new = $('<div class="chatlog-newroom"><span class="fa-solid fa-plus"></span> 새 로그 만들기</div>');
    $new.on('click', createRoomFlow);
    $b.append($new);
}

// ── 피드 ──────────────────────────────────────────────────
function renderFeed() {
    const room = state.rooms[view.roomId];
    if (!room) { view.screen = 'rooms'; return render(); }

    $('.chatlog-title').text(room.name);
    const $b = $('.chatlog-body').empty();

    const posts = (state.posts[room.id] || []).slice().sort((a, b) => b.createdAt - a.createdAt);

    const $bar = $(`
      <div class="chatlog-toolbar">
        <div class="chatlog-chip" data-act="upload"><span class="fa-solid fa-camera"></span> 올리기</div>
        <div class="chatlog-chip" data-act="daylog"><span class="fa-solid fa-table-cells-large"></span> 하루로그</div>
      </div>`);
    $bar.find('[data-act=upload]').on('click', () => uploadSheet(room));
    $bar.find('[data-act=daylog]').on('click', () => dayLogView(room));
    $b.append($bar);

    if (!posts.length) {
        $b.append('<div class="chatlog-empty">아직 아무것도 없어요.<br><small>지금 눈앞의 한 장을 올려보세요.</small></div>');
        return;
    }

    let lastDay = null;
    for (const p of posts) {
        const dk = dayKey(p.createdAt);
        if (dk !== lastDay) {
            lastDay = dk;
            $b.append(`<div class="chatlog-daysep">${new Date(p.createdAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}</div>`);
        }
        $b.append(postCard(p));
    }
}

function postCard(p) {
    const name = p.author === 'user' ? (ctx().name1 || '나') : (p.authorName || p.author);

    const comments = p.comments.map(c => `
      <div class="chatlog-comment${c.read ? '' : ' unread'}">
        <img class="chatlog-cavatar" src="${avatarUrl(c.author)}">
        <div class="chatlog-cbubble"><b>${esc(c.authorName || c.author)}</b> ${esc(c.text)}</div>
      </div>`).join('');

    return $(`
      <article class="chatlog-post">
        <div class="chatlog-frame">
          ${p.image ? `<img class="chatlog-photo" src="${esc(p.image)}">` : '<div class="chatlog-photo chatlog-nophoto"></div>'}
          <span class="chatlog-stamp">${timeLabel(p.createdAt)}</span>
          <div class="chatlog-author">
            <img src="${avatarUrl(p.author)}"><span>${esc(name)}</span>
          </div>
          ${p.text ? `<div class="chatlog-caption">${esc(p.text)}</div>` : ''}
        </div>
        ${comments ? `<div class="chatlog-comments">${comments}</div>` : ''}
      </article>`);
}

// ── 올리기 ────────────────────────────────────────────────
function uploadSheet(room) {
    const $sheet = $(`
      <div class="chatlog-sheet">
        <div class="chatlog-sheet-inner">
          <div class="chatlog-sheet-title">지금 이 순간</div>
          <label class="chatlog-filepick">
            <input type="file" accept="image/*" capture="environment" hidden>
            <div class="chatlog-preview"><span class="fa-solid fa-camera"></span><small>사진 고르기</small></div>
          </label>
          <textarea class="chatlog-input" rows="2" maxlength="60" placeholder="한 줄만"></textarea>
          <div class="chatlog-sheet-actions">
            <div class="menu_button chatlog-cancel">취소</div>
            <div class="menu_button chatlog-submit">올리기</div>
          </div>
        </div>
      </div>`);

    document.documentElement.appendChild($sheet[0]);

    let imageData = null;
    $sheet.find('input[type=file]').on('change', function () {
        const f = this.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            imageData = reader.result;
            $sheet.find('.chatlog-preview').html(`<img src="${imageData}">`);
        };
        reader.readAsDataURL(f);
    });

    const close = () => $sheet.remove();
    $sheet.on('click', e => { if (e.target === $sheet[0]) close(); });
    $sheet.find('.chatlog-cancel').on('click', close);

    $sheet.find('.chatlog-submit').on('click', async () => {
        const text = $sheet.find('.chatlog-input').val();
        if (!text && !imageData) return close();
        $sheet.find('.chatlog-submit').text('올리는 중...');
        try {
            let imagePath = null;
            if (imageData) imagePath = await uploadImage(imageData);
            await api('/post', { roomId: room.id, text, image: imagePath });
            close();
            refresh();
        } catch (e) {
            toastr?.error?.('업로드 실패: ' + e.message);
            $sheet.find('.chatlog-submit').text('올리기');
        }
    });
}

async function uploadImage(dataUrl) {
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({
            image: dataUrl.split(',')[1],
            ch_name: 'chatlog',
            filename: `post_${Date.now()}`,
            format: 'png',
        }),
    });
    if (!res.ok) throw new Error('image upload ' + res.status);
    const json = await res.json();
    return json.path;
}

// ── 하루로그 (분할 화면) ──────────────────────────────────
function dayLogView(room) {
    const posts = (state.posts[room.id] || [])
        .filter(p => dayKey(p.createdAt) === dayKey(Date.now()) && p.image)
        .sort((a, b) => a.createdAt - b.createdAt);

    const $sheet = $(`
      <div class="chatlog-sheet">
        <div class="chatlog-sheet-inner chatlog-daylog">
          <div class="chatlog-sheet-title">하루로그</div>
          <div class="chatlog-grid"></div>
          <div class="chatlog-sheet-actions">
            <div class="menu_button chatlog-cancel">닫기</div>
          </div>
        </div>
      </div>`);
    document.documentElement.appendChild($sheet[0]);

    const $grid = $sheet.find('.chatlog-grid');
    const n = posts.length;
    $grid.addClass(n <= 1 ? 'g1' : n <= 4 ? 'g2' : 'g3');

    if (!n) {
        $grid.html('<div class="chatlog-empty">오늘 사진이 아직 없어요.</div>');
    } else {
        posts.forEach(p => {
            $grid.append(`
              <div class="chatlog-cell">
                <img src="${esc(p.image)}">
                <span class="chatlog-stamp">${timeLabel(p.createdAt)}</span>
              </div>`);
        });
    }

    const close = () => $sheet.remove();
    $sheet.on('click', e => { if (e.target === $sheet[0]) close(); });
    $sheet.find('.chatlog-cancel').on('click', close);
}

// ── 방 만들기 ─────────────────────────────────────────────
async function createRoomFlow() {
    const c = ctx();
    const chars = c.characters || [];
    const name = await c.callGenericPopup?.('로그 이름', c.POPUP_TYPE?.INPUT, '우리 로그');
    if (!name) return;

    const $list = $('<div class="chatlog-charpick"></div>');
    chars.forEach(ch => {
        $list.append(`
          <label class="chatlog-charrow">
            <input type="checkbox" value="${esc(ch.avatar)}">
            <img src="${avatarUrl(ch.avatar)}"><span>${esc(ch.name)}</span>
          </label>`);
    });

    const ok = await c.callGenericPopup?.($list[0], c.POPUP_TYPE?.CONFIRM, '', { okButton: '만들기' });
    if (!ok) return;

    const picked = $list.find('input:checked').map((_, el) => el.value).get();
    const members = picked.map(av => {
        const ch = chars.find(x => x.avatar === av) || {};
        return {
            avatar: av,
            name: ch.name,
            description: ch.description,
            personality: ch.personality,
            scenario: ch.scenario,
            mesExample: ch.mes_example,
        };
    });

    await api('/room', { name, members, schedule: defaultSchedule });
    refresh();
}

async function markRead(roomId) {
    try { await api('/read', { roomId }); } catch {}
}


// ── 슬래시 커맨드 ─────────────────────────────────────────
function registerSlashCommands() {
    const c = ctx();
    const P = c.SlashCommandParser;
    const Cmd = c.SlashCommand;
    const Arg = c.SlashCommandNamedArgument;
    if (!P || !Cmd) { console.warn('[chatlog] 슬래시 커맨드 API 없음'); return; }

    const roomIdByName = (name) => {
        if (!name) return null;
        const room = Object.values(state.rooms).find(r => r.name === name);
        return room?.id || null;
    };

    const ensureState = async () => { state = await api('/state'); };

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog',
        helpString: '챗로그 열기',
        callback: async () => { openChatlog(); return ''; },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-run',
        helpString: '강제 실행. what=comments|cut|all (기본 all), room=로그 이름',
        namedArgumentList: [
            Arg?.fromProps?.({ name: 'what', description: 'comments | cut | all', defaultValue: 'all', isRequired: false }),
            Arg?.fromProps?.({ name: 'room', description: '로그 이름 (생략 시 전체)', isRequired: false }),
        ].filter(Boolean),
        callback: async (args) => {
            await ensureState();
            const r = await api('/force', { what: args.what || 'all', roomId: roomIdByName(args.room) });
            const msg = `댓글 ${r.comments}개, 컷 ${r.cuts}개 생성` + (r.errors?.length ? ` / 오류 ${r.errors.length}건` : '');
            toastr?.info?.(msg);
            if (r.errors?.length) console.warn('[chatlog]', r.errors);
            if ($overlay) refresh();
            return msg;
        },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-now',
        helpString: '다음 슬롯을 지금으로 당김 (다음 틱에 생성)',
        namedArgumentList: [Arg?.fromProps?.({ name: 'room', description: '로그 이름', isRequired: false })].filter(Boolean),
        callback: async (args) => {
            await ensureState();
            await api('/force/now', { roomId: roomIdByName(args.room) });
            toastr?.info?.('다음 슬롯을 지금으로 당겼어요 (1분 내 실행)');
            return 'ok';
        },
    }));

    P.addCommandObject(Cmd.fromProps({
        name: 'chatlog-jobs',
        helpString: '대기 중인 작업 목록',
        callback: async () => {
            const jobs = await api('/jobs');
            console.table(jobs);
            toastr?.info?.(`대기 중 ${jobs.length}건 (콘솔 확인)`);
            return JSON.stringify(jobs);
        },
    }));
}

// ── 진입 ──────────────────────────────────────────────────
jQuery(async () => {
    $('#extensions_settings2').append(SETTINGS_HTML);
    $('#chatlog-save').on('click', saveSettingsUi);
    $('#chatlog-open').on('click', openChatlog);
    $(document).on('input', '#chatlog-active-from, #chatlog-active-to, #chatlog-interval', updateCostHint);
    await loadSettingsUi();
    registerSlashCommands();
    console.log('[chatlog] 로드됨');
});
