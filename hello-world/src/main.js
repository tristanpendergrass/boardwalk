const button = document.getElementById("clicker");
const timerEl = document.getElementById("timer");
const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");

const GAME_SECONDS = 10;
let score = 0;
let endTime = null;
let tickHandle = null;

const best = Number(localStorage.getItem("hello-world-best") || 0);
if (best > 0) bestEl.textContent = `Best: ${best}`;

function tick() {
  const remaining = Math.max(0, endTime - Date.now()) / 1000;
  timerEl.textContent = remaining.toFixed(1);
  if (remaining <= 0) {
    clearInterval(tickHandle);
    endTime = null;
    button.textContent = "Play again";
    const prevBest = Number(localStorage.getItem("hello-world-best") || 0);
    if (score > prevBest) {
      localStorage.setItem("hello-world-best", String(score));
      bestEl.textContent = `New best: ${score}!`;
    }
  }
}

button.addEventListener("click", () => {
  if (endTime === null) {
    score = 0;
    scoreEl.textContent = "Score: 0";
    button.textContent = "Click me!";
    endTime = Date.now() + GAME_SECONDS * 1000;
    tickHandle = setInterval(tick, 100);
    return;
  }
  score++;
  scoreEl.textContent = `Score: ${score}`;
});

