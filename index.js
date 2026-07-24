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
      <div class="chatlog-row">
        <select id="chatlog-profile" class="text_pole"></select>
        <div id="chatlog-profile-refresh" class="menu_button fa-solid fa-rotate" title="목록 새로고침"></div>
      </div>
      <small id="chatlog-profile-count"></small>

      <small>서버가 이 프로필의 모델·키를 직접 읽어서 씁니다. 브라우저에서 돌릴 때도 이 프로필로 조용히 요청하며, 활성 프로필은 바뀌지 않습니다.</small>

      <label for="chatlog-image-provider">이미지 API 방식</label>
      <select id="chatlog-image-provider" class="text_pole">
        <option value="vertex">Vertex AI (Express 모드)</option>
        <option value="aistudio">Google AI Studio</option>
      </select>

      <label for="chatlog-image-key">이미지 생성 API 키</label>
      <input id="chatlog-image-key" type="password" class="text_pole" placeholder="이미지 전용 키">

      <div id="chatlog-vertex-fields">
        <label for="chatlog-image-project">프로젝트 ID</label>
        <input id="chatlog-image-project" type="text" class="text_pole" placeholder="my-project-123">

        <label for="chatlog-image-region">리전</label>
        <input id="chatlog-image-region" type="text" class="text_pole" placeholder="global">
        <small>모르겠으면 global 그대로 두세요.</small>
      </div>

      <label for="chatlog-image-model">이미지 모델 (나노바나나)</label>
      <select id="chatlog-image-model" class="text_pole">
        <option value="gemini-3.1-flash-lite-image">나노바나나 2 Lite — 제일 싸고 빠름 (권장)</option>
        <option value="gemini-3.1-flash-image">나노바나나 2 — 화질/속도 균형</option>
        <option value="gemini-3-pro-image">나노바나나 Pro — 최고 화질, 비쌈</option>
        <option value="gemini-2.5-flash-image">나노바나나 (구버전)</option>
        <option value="__custom">직접 입력...</option>
      </select>
      <input id="chatlog-image-model-custom" type="text" class="text_pole" style="display:none" placeholder="모델 ID">
      <div class="chatlog-row">
        <div id="chatlog-test-image" class="menu_button">이미지 생성 테스트</div>
      </div>
      <small id="chatlog-test-result"></small>

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

      <hr>
      <label class="checkbox_label">
        <input id="chatlog-autoclean" type="checkbox">
        <span>지난 기록 자동 삭제</span>
      </label>
      <div class="chatlog-row">
        <input id="chatlog-cleandays" type="number" min="0" max="30" class="text_pole">
        <span>일 지나면 삭제</span>
      </div>
      <label class="checkbox_label">
        <input id="chatlog-keepsaved" type="checkbox">
        <span>저장 표시한 건 남기기</span>
      </label>
      <small>사진 파일과 하루로그 영상까지 같이 지웁니다. 0일이면 오늘 것만 남아요.</small>
      <div class="chatlog-row">
        <div id="chatlog-cleannow" class="menu_button">지금 정리</div>
      </div>

      <div class="chatlog-row chatlog-actions">
        <div id="chatlog-save" class="menu_button">저장</div>
        <div id="chatlog-open" class="menu_button">챗로그 열기</div>
      </div>
    </div>
  </div>
</div>`;

function getProfiles() {
    const c = ctx();
    // ST 버전에 따라 위치가 다름 — 순서대로 시도
    return c?.extensionSettings?.connectionManager?.profiles
        || c?.extensionSettings?.['connection-manager']?.profiles
        || window.extension_settings?.connectionManager?.profiles
        || [];
}

function refreshProfileSelect(selected) {
    const profiles = getProfiles();
    const $sel = $('#chatlog-profile');
    const keep = selected ?? $sel.val();
    $sel.empty().append('<option value="">-- 선택 --</option>');
    profiles.forEach(p => $sel.append($('<option>').val(p.name).text(p.name)));
    if (keep && profiles.some(p => p.name === keep)) $sel.val(keep);
    $('#chatlog-profile-count').text(profiles.length ? `${profiles.length}개 감지됨` : '프로필을 못 찾았어요');
    return profiles;
}

const FALLBACK_SETTINGS = {
    profileName: '', imageApiKey: '', imageModel: 'gemini-3.1-flash-lite-image',
    commentDelayMinMin: 1, commentDelayMaxMin: 30,
    autoCleanup: false, cleanupAfterDays: 1, keepSaved: true,
    imageProvider: 'vertex', imageProjectId: '', imageRegion: 'global',
};

function toggleVertexFields() {
    $('#chatlog-vertex-fields').toggle($('#chatlog-image-provider').val() === 'vertex');
}

function setImageModel(value) {
    const $sel = $('#chatlog-image-model');
    const known = $sel.find('option').map((_, o) => o.value).get();
    if (value && !known.includes(value)) {
        $sel.val('__custom');
        $('#chatlog-image-model-custom').val(value).show();
    } else {
        $sel.val(value || 'gemini-3.1-flash-lite-image');
        $('#chatlog-image-model-custom').hide();
    }
}

function readImageModel() {
    const v = $('#chatlog-image-model').val();
    return v === '__custom' ? $('#chatlog-image-model-custom').val().trim() : v;
}

async function loadSettingsUi() {
    let s = FALLBACK_SETTINGS;
    try {
        s = { ...FALLBACK_SETTINGS, ...(await api('/settings')) };
    } catch (e) {
        // 서버 플러그인이 아직 안 붙었어도 UI는 정상적으로 채운다
        console.warn('[chatlog] 설정 불러오기 실패 — 기본값 사용', e);
        $('#chatlog-profile-count').text('서버 플러그인 응답 없음 (plugins/chatlog 확인)');
    }
    refreshProfileSelect(s.profileName);

    $('#chatlog-image-key').val(s.imageApiKey || '');
    setImageModel(s.imageModel);
    $('#chatlog-image-provider').val(s.imageProvider || 'vertex');
    $('#chatlog-image-project').val(s.imageProjectId || '');
    $('#chatlog-image-region').val(s.imageRegion || 'global');
    toggleVertexFields();
    $('#chatlog-delay-min').val(s.commentDelayMinMin);
    $('#chatlog-delay-max').val(s.commentDelayMaxMin);
    $('#chatlog-autoclean').prop('checked', !!s.autoCleanup);
    $('#chatlog-cleandays').val(s.cleanupAfterDays);
    $('#chatlog-keepsaved').prop('checked', !!s.keepSaved);

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
        imageModel: readImageModel(),
        imageProvider: $('#chatlog-image-provider').val(),
        imageProjectId: $('#chatlog-image-project').val().trim(),
        imageRegion: $('#chatlog-image-region').val().trim() || 'global',
        commentDelayMinMin: Number($('#chatlog-delay-min').val()),
        commentDelayMaxMin: Number($('#chatlog-delay-max').val()),
        userPersonaName: ctx().name1 || '',
        autoCleanup: $('#chatlog-autoclean').is(':checked'),
        cleanupAfterDays: Number($('#chatlog-cleandays').val()),
        keepSaved: $('#chatlog-keepsaved').is(':checked'),
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
        $('.chatlog-body').html(
            `<div class="chatlog-empty">서버 플러그인에 연결하지 못했어요<br>` +
            `<small>plugins/chatlog 설치와 ST 재시작을 확인해주세요<br>${esc(e.message)}</small></div>`);
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

    const $card = $(`
      <article class="chatlog-post" data-post="${p.id}">
        <div class="chatlog-frame">
          ${p.image ? `<img class="chatlog-photo" src="${esc(p.image)}">` : '<div class="chatlog-photo chatlog-nophoto"></div>'}
          <span class="chatlog-stamp">${timeLabel(p.createdAt)}</span>
          <div class="chatlog-author">
            <img src="${avatarUrl(p.author)}"><span>${esc(name)}</span>
          </div>
          ${p.text ? `<div class="chatlog-caption">${esc(p.text)}</div>` : ''}
        </div>
        ${comments ? `<div class="chatlog-comments">${comments}</div>` : ''}
        <div class="chatlog-postactions">
          ${p.image ? '<span class="chatlog-act" data-act="save"><span class="fa-solid fa-download"></span> 저장</span>' : ''}
          <span class="chatlog-act${p.saved ? ' on' : ''}" data-act="keep">
            <span class="fa-solid fa-thumbtack"></span> ${p.saved ? '보관됨' : '보관'}
          </span>
          <span class="chatlog-act" data-act="del"><span class="fa-solid fa-trash"></span></span>
        </div>
      </article>`);

    $card.find('[data-act=save]').on('click', async () => {
        try { await downloadUrl(p.image, `chatlog_${dayKey(p.createdAt)}_${p.id}.png`); }
        catch (e) { toastr?.error?.('저장 실패: ' + e.message); }
    });

    $card.find('[data-act=keep]').on('click', async () => {
        await api('/save', { roomId: p.roomId, postId: p.id, saved: !p.saved });
        refresh();
    });

    $card.find('[data-act=del]').on('click', async () => {
        if (!confirm('이 게시물을 지울까요? 사진도 같이 삭제됩니다.')) return;
        await api('/delete', { roomId: p.roomId, postId: p.id });
        refresh();
    });

    return $card;
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
            <div class="menu_button chatlog-export">움짤 저장</div>
            <div class="menu_button chatlog-cancel">닫기</div>
          </div>
          <div class="chatlog-progress"></div>
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

    const $btn = $sheet.find('.chatlog-export');
    const $prog = $sheet.find('.chatlog-progress');
    $btn.toggleClass('disabled', !n);

    $btn.on('click', async () => {
        if (!n || $btn.hasClass('busy')) return;
        $btn.addClass('busy').text('만드는 중...');
        try {
            await exportDayLogVideo(posts, room.name, (i, total) => {
                $prog.text(`${i} / ${total}`);
            });
            $prog.text('저장 완료');
        } catch (e) {
            $prog.text('실패: ' + e.message);
        } finally {
            $btn.removeClass('busy').text('움짤 저장');
        }
    });

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



// ═══════════ 백그라운드 생성 (UI 안 뜸) ═══════════
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * ConnectionManagerRequestService — 확장이 연결 프로필로 요청을 보내되
 * 활성 프로필도, 채팅 UI도 건드리지 않는 ST 내장 서비스.
 * 이걸 쓰면 프로필 전환 자체가 필요 없고 생성 UI도 안 뜬다.
 */
let _cmrs = null;
async function getRequestService() {
    if (_cmrs) return _cmrs;
    const c = ctx();
    if (c.ConnectionManagerRequestService) return (_cmrs = c.ConnectionManagerRequestService);
    try {
        const mod = await import('/scripts/extensions/shared.js');
        if (mod?.ConnectionManagerRequestService) return (_cmrs = mod.ConnectionManagerRequestService);
    } catch (e) {
        console.warn('[chatlog] shared.js 로드 실패', e);
    }
    return null;
}

function profileByName(name) {
    return getProfiles().find(p => p.name === name) || null;
}

/** 조용히 한 번 생성. 실패하면 null. */
async function quietGenerate(messages, maxTokens = 200) {
    const svc = await getRequestService();
    const profileName = $('#chatlog-profile').val() || (await api('/settings')).profileName;
    const profile = profileByName(profileName);

    if (!svc || !profile) {
        console.warn('[chatlog] 백그라운드 생성 불가 — 서버 생성으로 넘기세요');
        return null;
    }

    const res = await svc.sendRequest(profile.id, messages, maxTokens);
    if (typeof res === 'string') return res;
    return res?.content ?? res?.text ?? '';
}

const COMMENT_RULES = [
    '- 댓글은 1~2문장, 40자 내외. 짧을수록 좋다.',
    '- SNS 댓글 말투. 완결된 문장이 아니어도 된다.',
    '- 사진이 있으면 구체적인 것 하나를 집어서 반응하라.',
    '- 나레이션, 행동 묘사(*...*), 따옴표, 이름표 금지. 댓글 텍스트만 출력한다.',
].join('\n');

function buildCommentMessages(job) {
    const m = job.member || {};
    const p = job.post || {};

    const system = [
        `너는 "${m.name}"이다.`,
        m.description ? `설명: ${m.description}` : '',
        m.personality ? `성격: ${m.personality}` : '',
        m.mesExample ? `말투 예시:\n${m.mesExample}` : '',
        '',
        `지금 "${job.roomName}" 로그에 올라온 게시물에 댓글을 단다.`,
        COMMENT_RULES,
    ].filter(Boolean).join('\n');

    const user = [
        `[${timeLabel(p.createdAt)} 게시물]`,
        p.text ? `글: ${p.text}` : '(글 없음)',
        p.image ? '(사진 첨부됨)' : '',
        '',
        '댓글 하나만 출력하라.',
    ].filter(Boolean).join('\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function cleanComment(raw) {
    return (raw || '')
        .trim()
        .replace(/^["'\u300c\u300e]|["'\u300d\u300f]$/g, '')
        .replace(/^\*+|\*+$/g, '')
        .replace(/^[^:\n]{1,20}:\s*/, '')
        .split('\n')[0]
        .slice(0, 120)
        .trim();
}

/** 브라우저에서 대기 댓글 처리 — 채팅 UI에 아무것도 안 뜬다 */
async function runLocal(roomId = null) {
    const svc = await getRequestService();
    if (!svc) {
        toastr?.warning?.('백그라운드 생성 API를 못 찾았어요. /chatlog-run 으로 서버에서 돌리세요');
        return 0;
    }

    const jobs = await api('/jobs/claim', { roomId, type: 'comment' });
    if (!jobs.length) { toastr?.info?.('대기 중인 댓글이 없어요'); return 0; }

    let ok = 0;
    for (const job of jobs) {
        try {
            const raw = await quietGenerate(buildCommentMessages(job));
            if (raw == null) throw new Error('생성 실패');
            await api('/comment/push', {
                roomId: job.roomId,
                postId: job.postId,
                charId: job.charId,
                charName: job.member?.name,
                text: cleanComment(raw),
            });
            ok++;
        } catch (e) {
            console.error('[chatlog] 댓글 생성 실패', job.charId, e);
        }
        await delay(400);   // 연타 방지
    }

    toastr?.success?.(`댓글 ${ok}개 생성`);
    if ($overlay) refresh();
    return ok;
}

// ═══════════ 저장 / 내보내기 ═══════════
async function downloadUrl(url, filename) {
    const blob = await (await fetch(url)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function loadImg(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

/** 하루로그를 움짤(webm)로 내보내기 — 컷당 0.7초, 켄번스 줌 */
async function exportDayLogVideo(posts, roomName, onProgress) {
    const W = 720, H = 960, HOLD = 700;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');

    const stream = canvas.captureStream(30);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('이 브라우저는 영상 녹화를 지원하지 않아요');

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => { rec.onstop = r; });
    rec.start();

    for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        onProgress?.(i + 1, posts.length);
        let img;
        try { img = await loadImg(p.image); } catch { continue; }

        const start = performance.now();
        await new Promise(resolve => {
            const draw = () => {
                const t = Math.min(1, (performance.now() - start) / HOLD);
                const zoom = 1.04 + t * 0.05;               // 느린 줌인
                const dw = W * zoom, dh = H * zoom;

                g.fillStyle = '#000';
                g.fillRect(0, 0, W, H);

                // cover 맞춤
                const scale = Math.max(dw / img.width, dh / img.height);
                const iw = img.width * scale, ih = img.height * scale;
                g.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);

                // 시간 스탬프
                g.fillStyle = 'rgba(0,0,0,0.55)';
                g.roundRect?.(24, 24, 190, 52, 26);
                g.fill();
                g.fillStyle = '#fff';
                g.font = '600 28px -apple-system, sans-serif';
                g.textBaseline = 'middle';
                g.fillText(timeLabel(p.createdAt), 44, 51);

                if (p.text) {
                    g.fillStyle = 'rgba(0,0,0,0.6)';
                    g.fillRect(0, H - 110, W, 110);
                    g.fillStyle = '#fff';
                    g.font = '550 32px -apple-system, sans-serif';
                    g.fillText(p.text.slice(0, 24), 40, H - 55);
                }

                if (t >= 1) resolve();
                else requestAnimationFrame(draw);
            };
            draw();
        });
    }

    rec.stop();
    await done;

    const blob = new Blob(chunks, { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `daylog_${roomName}_${dayKey(Date.now())}.webm`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
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
        name: 'chatlog-local',
        helpString: '대기 댓글을 브라우저에서 조용히 생성 (채팅 UI에 안 뜸)',
        namedArgumentList: [Arg?.fromProps?.({ name: 'room', description: '로그 이름', isRequired: false })].filter(Boolean),
        callback: async (args) => {
            await ensureState();
            const n = await runLocal(roomIdByName(args.room));
            return String(n);
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
    $('#chatlog-profile-refresh').on('click', () => {
        const n = refreshProfileSelect().length;
        toastr?.info?.(n ? `연결 프로필 ${n}개` : '연결 프로필을 못 찾았어요');
    });
    $('#chatlog-image-provider').on('change', toggleVertexFields);
    $('#chatlog-image-model').on('change', function () {
        $('#chatlog-image-model-custom').toggle(this.value === '__custom');
    });
    $('#chatlog-test-image').on('click', async () => {
        const $r = $('#chatlog-test-result').text('생성 중...');
        try {
            await api('/settings', {
                imageApiKey: $('#chatlog-image-key').val(),
                imageModel: readImageModel(),
                imageProvider: $('#chatlog-image-provider').val(),
                imageProjectId: $('#chatlog-image-project').val().trim(),
                imageRegion: $('#chatlog-image-region').val().trim() || 'global',
            });
            const r = await api('/test/image', {});
            $r.html(`성공 — <a href="${r.path}" target="_blank">이미지 보기</a>`);
        } catch (e) {
            $r.text('실패: ' + e.message);
        }
    });
    $('#chatlog-cleannow').on('click', async () => {
        if (!confirm('지난 기록을 지금 정리할까요?')) return;
        await api('/cleanup', { force: true });
        toastr?.success?.('정리 완료');
        if ($overlay) refresh();
    });
    // 확장 설정 드로어를 열 때마다 프로필 목록 갱신
    $(document).on('click', '.chatlog-settings .inline-drawer-toggle', () => setTimeout(() => refreshProfileSelect(), 50));
    $(document).on('input', '#chatlog-active-from, #chatlog-active-to, #chatlog-interval', updateCostHint);
    await loadSettingsUi();
    registerSlashCommands();
    console.log('[chatlog] 로드됨');
});
