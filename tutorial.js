/*
  M5 Tutorial World (separate page)
  Goals (per latest UX spec):
  - No focus-cue overlays here (Options handles the only required focus cues).
  - Clear step order:
      1) show the whole world
      2) what you can do / how to use
      3) highlight (Spotlight) explanation + experience (both buttons just dismiss)
      4) leveling / XP explanation
      5) choose: end now or continue freeplay
  - Character is the narrator: speech-bubble + standing avatar (PetEngine canvas).
*/

const $ = (id) => document.getElementById(id);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function setText(el, text){ if (el) el.textContent = String(text ?? ""); }

function normalizeCharId(id){
  if (id === "likoris") return "likoris";
  // legacy
  if (id === "forone") return "follone";
  return "follone";
}

function charName(charId){
  return charId === "likoris" ? "りこりす" : "ふぉろね";
}

async function sendSW(msg){
  try { return await chrome.runtime.sendMessage(msg); }
  catch (e) { return { ok:false, error:String(e) }; }
}

async function getProgress(){
  const r = await sendSW({ type: "FOLLONE_GET_PROGRESS" });
  if (r && r.ok) return r;
  // fallback (tutorial should still run)
  return { ok:false, xp:0, level:1, equippedHead:"" };
}

async function addXp(amount){
  const r = await sendSW({ type: "FOLLONE_ADD_XP", amount: Number(amount)||0 });
  return (r && r.ok) ? r : null;
}

async function markOnboardingDone(){
  try { await chrome.storage.local.set({ follone_onboarding_done: true, follone_onboarding_phase: "done", follone_onboarding_state: "completed" }); }
  catch(_e) {}
}

async function loadGuideAvatar(charId){
  const canvas = $("guidePet");
  if (!canvas) return;

  canvas.style.imageRendering = "pixelated";
  canvas.width = 64;
  canvas.height = 64;

  try {
    if (!window.PetEngine) return;
    const eng = new window.PetEngine({ canvas });

    const base = "pet/data";
    const charURL = chrome.runtime.getURL(`${base}/characters/${charId}.json`);
    const accURL = chrome.runtime.getURL(`${base}/accessories/accessories.json`);

    const [resChar, resAcc] = await Promise.all([
      fetch(charURL, { cache: "no-store" }),
      fetch(accURL, { cache: "no-store" })
    ]);
    if (!resChar.ok) return;

    const char = await resChar.json();
    const accessories = resAcc.ok ? await resAcc.json() : null;

    const prog = await getProgress();
    const head = prog?.equippedHead ? String(prog.equippedHead) : null;

    eng.renderPet({
      char,
      accessories,
      eyesVariant: "normal",
      mouthVariant: "idle",
      equip: { head, fx: null }
    });
  } catch (_e) {
    // non-blocking
  }
}

async function say(lines, { clear=true, lineDelay=230 } = {}){
  const box = $("guideText");
  if (!box) return;
  if (clear) box.innerHTML = "";

  for (const line of lines) {
    const div = document.createElement("div");
    div.className = "tLine";
    div.textContent = line;
    box.appendChild(div);
    await sleep(lineDelay);
  }
}

function setActions(buttons){
  const wrap = $("guideActions");
  if (!wrap) return;
  wrap.innerHTML = "";
  buttons.forEach(b => wrap.appendChild(b));
}

function mkBtn(label, { kind="normal" } = {}){
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (kind === "ghost") b.classList.add("tGhost");
  return b;
}

async function showSpotlightOnce({ allowXp=true } = {}){
  const veil = $("spotVeil");
  const btnBack = $("spotBack");
  const btnSearch = $("spotSearch");
  if (!veil || !btnBack || !btnSearch) return { choice:"none", gained:0 };

  // show
  veil.classList.add("on");
  await sleep(60);
  btnBack.classList.add("tPulse");
  btnSearch.classList.add("tPulse");

  const choice = await new Promise((resolve) => {
    btnBack.addEventListener("click", () => resolve("back"), { once:true });
    btnSearch.addEventListener("click", () => resolve("search"), { once:true });
  });

  btnBack.classList.remove("tPulse");
  btnSearch.classList.remove("tPulse");

  // hide
  veil.classList.add("out");
  await sleep(220);
  veil.classList.remove("on");
  veil.classList.remove("out");

  let gained = 0;
  if (allowXp) {
    gained = 10;
    const r = await addXp(gained);
    if (r && r.ok) {
      setText($("hudLv"), r.level);
      setText($("hudXp"), r.xp);
      setText($("hudGain"), gained);
      const chip = $("hudGain");
      if (chip) {
        chip.classList.add("xp-pop");
        setTimeout(() => chip.classList.remove("xp-pop"), 450);
      }
    } else {
      // fallback display only
      const p = await getProgress();
      setText($("hudLv"), p.level || 1);
      setText($("hudXp"), p.xp || 0);
      setText($("hudGain"), gained);
    }
  }

  return { choice, gained };
}

async function enterFreeplay(){
  const postHot = $("postHot");
  const post0 = document.querySelector('[data-post="0"]');
  const post2 = document.querySelector('[data-post="2"]');

  const clickHint = async () => {
    await say([
      "OK。ここからは自由に試せるよ。",
      "投稿をクリックするとSpotlightを出せる（練習用）。",
      "どちらのボタンでもSpotlightは閉じるよ。",
    ]);
    setActions([mkBtn("Xへ戻る")]);
    $("guideActions")?.firstChild?.addEventListener("click", async () => {
      await markOnboardingDone();
      try { window.close(); } catch(_e) {}
    }, { once:true });
  };

  await clickHint();

  const handler = async () => {
    await showSpotlightOnce({ allowXp:true });
    // after each, keep the hint minimal (don’t overwrite too aggressively)
  };

  // make posts clickable
  [post0, postHot, post2].forEach((p) => {
    if (!p) return;
    p.classList.add("isTarget");
    p.style.cursor = "pointer";
    p.addEventListener("click", handler);
  });
}

async function main(){
  // Read character selection early
  let charId = "follone";
  try {
    const cur = await chrome.storage.local.get(["follone_characterId"]);
    charId = normalizeCharId(cur.follone_characterId);
  } catch (_e) {}

  setText($("guideChar"), charName(charId));

  // Initial HUD
  const p = await getProgress();
  setText($("hudLv"), p.level || 1);
  setText($("hudXp"), p.xp || 0);
  setText($("hudGain"), 0);

  // Render guide avatar (non-blocking)
  loadGuideAvatar(charId);

  // Step 1: show the whole world (no overlays, just narration)
  setActions([mkBtn("次へ")]);
  await say([
    "まずは全体を見てみよう。",
    "ここは“仮想タイムライン”。本物のXには影響しないよ。",
    "迷ったときにだけ、私が選択肢を出す…そんな使い方。",
  ]);
  await new Promise(r => $("guideActions")?.firstChild?.addEventListener("click", r, { once:true }));

  // Step 2: what you can do / how to use
  setActions([mkBtn("次へ")]);
  await say([
    "使い方はシンプル。",
    "強い言葉や煽りに出会ったら、Spotlightが出る。",
    "そこで“戻る”か“検索する”を選ぶだけ。",
  ]);
  await new Promise(r => $("guideActions")?.firstChild?.addEventListener("click", r, { once:true }));

  // Step 3: highlight explanation + experience
  const btnDo = mkBtn("ハイライトを体験する");
  setActions([btnDo]);
  // gently highlight the hot post
  $("postHot")?.classList.add("isTarget");
  $("postHot")?.scrollIntoView({ behavior:"smooth", block:"center" });
  await sleep(200);
  await say([
    "これが“ハイライト（Spotlight）”。",
    "今の投稿みたいに、感情が引っ張られやすいときに出すよ。",
    "どっちのボタンでもOK。押したら普通に閉じる。",
  ]);
  await new Promise(r => btnDo.addEventListener("click", r, { once:true }));

  const { choice } = await showSpotlightOnce({ allowXp:true });
  const fb = (choice === "search")
    ? "別の視点を見るのは、安全な行動。"
    : "距離を取るのも、とても良い選択。";
  await say([fb]);

  // Step 4: leveling explanation (XP visible here)
  setActions([mkBtn("次へ")]);
  await say([
    "いまの行動でXPが増えたの、見えた？",
    "落ち着いた選択を積み重ねると、レベルが上がってアクセが解放される。",
    "（報酬は“安全に使えた”の副産物、って感じ）",
  ]);
  await new Promise(r => $("guideActions")?.firstChild?.addEventListener("click", r, { once:true }));

  // Step 5: end or continue
  const btnEnd = mkBtn("ここで終わる（Xへ戻る)");
  const btnMore = mkBtn("もう少し続ける");
  setActions([btnMore, btnEnd]);
  await say([
    "ここまでで基本はOK。",
    "このままXに戻る？ それとも、もう少し練習する？",
  ]);

  const next = await new Promise((resolve) => {
    btnEnd.addEventListener("click", () => resolve("end"), { once:true });
    btnMore.addEventListener("click", () => resolve("more"), { once:true });
  });

  if (next === "end") {
    await markOnboardingDone();
    try { window.close(); } catch(_e) {}
    return;
  }

  await enterFreeplay();
}

main().catch((e) => {
  console.error(e);
  try { setText($("guideText"), "チュートリアルでエラーが起きました。Optionsから再実行してください。" ); } catch(_e) {}
});
