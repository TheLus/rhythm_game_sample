const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const goldValueEl = document.getElementById("goldValue");
const baseHpValueEl = document.getElementById("baseHpValue");
const baseHpBarFillEl = document.getElementById("baseHpBarFill");
const baseHpBarTextEl = document.getElementById("baseHpBarText");
const waveValueEl = document.getElementById("waveValue");
const statusTextEl = document.getElementById("statusText");
const holdDurationSlider = document.getElementById("holdDurationSlider");
const holdDurationValueEl = document.getElementById("holdDurationValue");
const settingsToggle = document.getElementById("settingsToggle");
const settingsClose = document.getElementById("settingsClose");
const settingsPanel = document.getElementById("settingsPanel");

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const LANE_COUNT = 3;
const LANE_WIDTH = WIDTH / LANE_COUNT;
const MAX_BASE_HP = 5;
const DEPLOY_Y = HEIGHT - 80;
const CELL_SIZE = 48;
const MOVE_DURATION = 0.22;
const MELEE_CENTER_GAP = 40;
const MIN_ATTACK_GAP = 8;
const ATTACK_ANIM_DURATION = 0.14;
const JUMP_SCALE_Y = 0.26;
const JUMP_SCALE_X = 0.14;
const JUMP_LIFT = 18;

const PICKER_WEAPON_RADIUS = 72;
const PICKER_ELEMENT_RADIUS = 52;
const PICKER_HIT_RADIUS = 28;
const PICKER_ICON_HEIGHT = 34;
const PICKER_MIN_RADIUS = 34;
const PICKER_EDGE_PAD = 6;
const PICKER_FAN_START = (-Math.PI * 5) / 6;
const PICKER_FAN_END = -Math.PI / 6;

let holdDuration = 0.92;

const MAP_BACKGROUND_PATH = "assets/images/map_background.png";
const DEPLOY_ZONE_TOP = DEPLOY_Y + 22;

let mapBackgroundImage = null;
let mapBackgroundCanvas = null;

function getTurnCycle() {
  return MOVE_DURATION + holdDuration;
}

const weaponAdvantage = {
  sword: "axe",
  axe: "spear",
  spear: "sword"
};

const elementAdvantage = {
  fire: "grass",
  grass: "water",
  water: "fire"
};

const elementLabels = {
  fire: "火",
  water: "水",
  grass: "草"
};

const weaponLabels = {
  sword: "剣",
  axe: "斧",
  spear: "槍"
};

const UNIT_IMAGE_DIR = "assets/images/unit/";
const WEAPON_TYPES = ["sword", "axe", "spear"];
const ELEMENT_TYPES = ["fire", "water", "grass"];
const unitImages = {};

const BASE_UNIT_STATS = {
  atk: 12,
  hp: 80,
  range: 180,
  attackInterval: 0.85
};

function unitImageKey(weaponType, elementType) {
  return `${weaponType}_${elementType}`;
}

function buildUnitCatalog() {
  const catalog = [];
  for (const weaponType of WEAPON_TYPES) {
    for (const elementType of ELEMENT_TYPES) {
      catalog.push({
        id: unitImageKey(weaponType, elementType),
        name: `${weaponLabels[weaponType]}兵・${elementLabels[elementType]}`,
        weaponType,
        elementType,
        ...BASE_UNIT_STATS
      });
    }
  }
  return catalog;
}

function loadUnitImages() {
  const tasks = [];
  for (const weaponType of WEAPON_TYPES) {
    for (const elementType of ELEMENT_TYPES) {
      const key = unitImageKey(weaponType, elementType);
      const img = new Image();
      unitImages[key] = img;
      tasks.push(
        new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`${key}.png`));
          img.src = `${UNIT_IMAGE_DIR}${key}.png`;
        })
      );
    }
  }
  return Promise.all(tasks);
}

function getUnitImage(entity) {
  const key = unitImageKey(entity.weaponType, entity.elementType);
  const img = unitImages[key];
  if (!img || !img.complete || img.naturalWidth === 0) return null;
  return img;
}

function drawUnitSprite(entity, render) {
  const img = getUnitImage(entity);
  if (!img) return;

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  ctx.save();
  ctx.translate(Math.round(render.x), Math.round(render.feetY));
  ctx.scale(render.scaleX, render.scaleY);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, Math.round(-w / 2), Math.round(-h), w, h);
  ctx.restore();
}

const unitCatalog = buildUnitCatalog();

const deployPicker = {
  active: false,
  phase: "weapon",
  pointerId: null,
  anchorX: 0,
  anchorY: 0,
  pointerX: 0,
  pointerY: 0,
  lane: 0,
  weaponIndex: -1,
  weaponType: null,
  elementIndex: -1,
  elementType: null
};

const state = {
  gold: 120,
  baseHp: MAX_BASE_HP,
  wave: 1,
  allies: [],
  enemies: [],
  turnCount: 0,
  turnTimer: 0,
  spawnTurnTimer: 2,
  waveTurnCounter: 0,
  pendingAttacks: [],
  defeatsResolved: false,
  over: false
};

function laneCenterX(lane) {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function getRelationSign(attacker, defender, type) {
  const chart = type === "weapon" ? weaponAdvantage : elementAdvantage;
  const attackerValue = type === "weapon" ? attacker.weaponType : attacker.elementType;
  const defenderValue = type === "weapon" ? defender.weaponType : defender.elementType;
  if (chart[attackerValue] === defenderValue) return 1;
  if (chart[defenderValue] === attackerValue) return -1;
  return 0;
}

function getMatchupTier(attacker, defender) {
  const weapon = getRelationSign(attacker, defender, "weapon");
  const element = getRelationSign(attacker, defender, "element");

  if (weapon === 1 && element === 1) return "bothAdvantage";
  if (weapon === -1 && element === -1) return "bothDisadvantage";
  if ((weapon === 1 && element === 0) || (weapon === 0 && element === 1)) {
    return "oneAdvantage";
  }
  if ((weapon === -1 && element === 0) || (weapon === 0 && element === -1)) {
    return "oneDisadvantage";
  }
  return "neutral";
}

// 最大有利1撃 / 有利2撃 / 通常3撃 / 不利4撃 / 最大不利5撃
const MATCHUP_HITS_TO_KILL = {
  bothAdvantage: 1,
  oneAdvantage: 2,
  neutral: 3,
  oneDisadvantage: 4,
  bothDisadvantage: 5
};

function computeDamage(attacker, defender) {
  const tier = getMatchupTier(attacker, defender);
  const hits = MATCHUP_HITS_TO_KILL[tier];
  const hp = defender.maxHp > 0 ? defender.maxHp : defender.hp;
  const damagePerHit = Math.ceil(hp / hits);
  const atkScale = attacker.atk / BASE_UNIT_STATS.atk;
  return Math.max(1, Math.floor(damagePerHit * atkScale));
}

function setStatus(text) {
  statusTextEl.textContent = text;
}

function getHpBarColor(ratio) {
  if (ratio <= 0.2) return "#ff4757";
  if (ratio <= 0.6) return "#ffd166";
  return "#2ed573";
}

function updateHUD() {
  goldValueEl.textContent = String(state.gold);
  baseHpValueEl.textContent = String(state.baseHp);
  waveValueEl.textContent = String(state.wave);
  const hpRatio = Math.max(0, state.baseHp / MAX_BASE_HP);
  baseHpBarFillEl.style.width = `${hpRatio * 100}%`;
  baseHpBarFillEl.style.background = getHpBarColor(hpRatio);
  baseHpBarTextEl.textContent = `${state.baseHp} / ${MAX_BASE_HP}`;
}

function cloneUnitConfig(config) {
  return {
    ...config,
    maxHp: config.hp,
    x: 0,
    prevY: DEPLOY_Y,
    y: DEPLOY_Y,
    lane: 0
  };
}

function makeEnemy() {
  const lane = Math.floor(Math.random() * LANE_COUNT);
  const weapons = ["sword", "axe", "spear"];
  const elements = ["fire", "water", "grass"];
  const weaponType = weapons[Math.floor(Math.random() * weapons.length)];
  const elementType = elements[Math.floor(Math.random() * elements.length)];
  const hpScale = 1 + (state.wave - 1) * 0.08;
  const atkScale = 1 + (state.wave - 1) * 0.05;
  return {
    lane,
    x: laneCenterX(lane),
    prevY: 24,
    y: 24,
    hp: Math.floor(BASE_UNIT_STATS.hp * hpScale),
    maxHp: 0,
    atk: Math.floor(BASE_UNIT_STATS.atk * atkScale),
    reward: 12 + Math.floor(state.wave * 1.5),
    weaponType,
    elementType
  };
}

function spawnEnemy() {
  const enemy = makeEnemy();
  enemy.maxHp = enemy.hp;
  state.enemies.push(enemy);
}

function getUnitById(id) {
  return unitCatalog.find((u) => u.id === id);
}

function deployUnitToLane(lane, weaponType, elementType) {
  if (state.over) return false;
  const config = getUnitById(unitImageKey(weaponType, elementType));
  if (!config) return false;

  const occupant = state.allies.find((a) => a.lane === lane);
  if (occupant) {
    setStatus("そのレーンには既に味方がいます。");
    return false;
  }
  const ally = cloneUnitConfig(config);
  ally.lane = lane;
  ally.x = laneCenterX(lane);
  state.allies.push(ally);
  setStatus(`${config.name} を ${lane + 1} レーンへ配置。`);
  updateHUD();
  return true;
}

function updateEnemies(dt) {
  void dt;
}

function pickTargetInLane(attacker, candidates, maxDistance = Infinity) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const target of candidates) {
    if (target.lane !== attacker.lane) continue;
    const dist = Math.abs(target.y - attacker.y);
    if (dist <= maxDistance && dist < nearestDist) {
      nearestDist = dist;
      nearest = target;
    }
  }
  return nearest;
}

function updateAllies(now) {
  void now;
}

function isInMeleeRange(a, b) {
  return a.lane === b.lane && Math.abs(a.y - b.y) <= MELEE_CENTER_GAP + 1;
}

function hasMeleeTarget(entity, opponents) {
  return opponents.some((opponent) => isInMeleeRange(entity, opponent));
}

function getStandoffY(unit, target) {
  if (unit.y > target.y) return target.y + MELEE_CENTER_GAP;
  return target.y - MELEE_CENTER_GAP;
}

function clearAttackAnims() {
  for (const unit of [...state.allies, ...state.enemies]) {
    unit.hadAttack = false;
    unit.attackTarget = null;
  }
}

function triggerAttackAnim(attacker, target) {
  attacker.hadAttack = true;
  attacker.attackTarget = target;
  attacker.attackDir = target.y < attacker.y ? -1 : 1;
}

function markPreviousPosition() {
  for (const ally of state.allies) {
    ally.prevY = ally.y;
  }
  for (const enemy of state.enemies) {
    enemy.prevY = enemy.y;
  }
}

function moveAlliesOneCell() {
  for (const ally of state.allies) {
    const enemy = pickTargetInLane(ally, state.enemies, Infinity);
    if (enemy) {
      const standoffY = getStandoffY(ally, enemy);
      ally.y = Math.max(64, Math.max(standoffY, ally.y - CELL_SIZE));
    } else {
      ally.y = Math.max(64, ally.y - CELL_SIZE);
    }
  }
}

function moveEnemiesOneCell() {
  const survivors = [];
  for (const enemy of state.enemies) {
    const ally = pickTargetInLane(enemy, state.allies, Infinity);
    if (ally) {
      const standoffY = getStandoffY(enemy, ally);
      enemy.y = Math.min(standoffY, enemy.y + CELL_SIZE);
    } else {
      enemy.y += CELL_SIZE;
    }

    if (enemy.y >= HEIGHT - 14) {
      state.baseHp -= 1;
      setStatus("敵が突破しました。");
      continue;
    }
    survivors.push(enemy);
  }
  state.enemies = survivors;
}

function normalizeMeleeStandoff() {
  for (const ally of state.allies) {
    const enemy = pickTargetInLane(ally, state.enemies, MELEE_CENTER_GAP + CELL_SIZE);
    if (!enemy || !isInMeleeRange(ally, enemy)) continue;
    ally.y = enemy.y + MELEE_CENTER_GAP;
    enemy.y = ally.y - MELEE_CENTER_GAP;
  }
}

function scheduleMeleeCombat() {
  state.pendingAttacks = [];
  state.defeatsResolved = false;

  for (const ally of state.allies) {
    const enemy = pickTargetInLane(ally, state.enemies, MELEE_CENTER_GAP + 1);
    if (!enemy) continue;
    triggerAttackAnim(ally, enemy);
    state.pendingAttacks.push({
      target: enemy,
      damage: computeDamage(ally, enemy),
      applied: false
    });
  }

  for (const enemy of state.enemies) {
    const ally = pickTargetInLane(enemy, state.allies, MELEE_CENTER_GAP + 1);
    if (!ally) continue;
    triggerAttackAnim(enemy, ally);
    state.pendingAttacks.push({
      target: ally,
      damage: computeDamage(enemy, ally),
      applied: false
    });
  }
}

function isPendingDamageReady(force = false) {
  if (force) return state.pendingAttacks.some((hit) => !hit.applied);
  return getHoldPhaseTime() >= ATTACK_ANIM_DURATION;
}

function applyPendingAttackDamage(force = false) {
  if (!isPendingDamageReady(force)) return;

  for (const hit of state.pendingAttacks) {
    if (hit.applied) continue;
    if (hit.target.hp <= 0) {
      hit.applied = true;
      continue;
    }
    hit.target.hp -= hit.damage;
    hit.applied = true;
  }
}

function resolveDefeatsAfterDamage() {
  if (state.pendingAttacks.length === 0) return;
  if (!state.pendingAttacks.every((hit) => hit.applied)) return;
  if (state.defeatsResolved) return;
  resolveDefeatedEnemies();
  resolveDefeatedAllies();
  state.defeatsResolved = true;
}

function resolveDefeatedEnemies() {
  let earned = 0;
  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) {
      earned += enemy.reward;
    }
  }
  if (earned > 0) {
    state.gold += earned;
    setStatus(`敵撃破で ${earned}G 獲得。`);
  }
  state.enemies = state.enemies.filter((e) => e.hp > 0);
}

function resolveDefeatedAllies() {
  state.allies = state.allies.filter((ally) => ally.hp > 0);
}

function maybeAdvanceWave() {
  state.waveTurnCounter += 1;
  if (state.waveTurnCounter >= 56) {
    state.waveTurnCounter = 0;
    state.wave += 1;
    setStatus(`Wave ${state.wave} 開始。敵が強化されます。`);
  }
}

function updateSpawn(dt) {
  void dt;
}

function updateSpawnTurn() {
  state.spawnTurnTimer -= 1;
  if (state.spawnTurnTimer <= 0) {
    spawnEnemy();
    const maxInterval = Math.max(3, 6 - Math.floor(state.wave / 2));
    state.spawnTurnTimer = 2 + Math.floor(Math.random() * maxInterval);
  }
}

function clientToCanvas(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * WIDTH,
    y: ((clientY - rect.top) / rect.height) * HEIGHT
  };
}

function getLaneFromCanvasX(canvasX) {
  const lane = Math.floor(canvasX / LANE_WIDTH);
  return Math.max(0, Math.min(LANE_COUNT - 1, lane));
}

function isInDeployZone(canvasY) {
  return canvasY >= DEPLOY_Y - 28;
}

function measureFanPositions(cx, cy, count, radius, startAngle, endAngle) {
  const positions = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const angle = startAngle + (endAngle - startAngle) * t;
    positions.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    });
  }
  return positions;
}

function fitPickerFanPositions(anchorX, anchorY, count, preferredRadius) {
  const padX = PICKER_EDGE_PAD + PICKER_HIT_RADIUS + 4;
  const padTop = PICKER_ICON_HEIGHT + PICKER_HIT_RADIUS + 4;
  const padBottom = PICKER_HIT_RADIUS + 14;

  let cx = anchorX;
  let cy = anchorY;
  let radius = preferredRadius;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const positions = measureFanPositions(cx, cy, count, radius, PICKER_FAN_START, PICKER_FAN_END);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pos of positions) {
      minX = Math.min(minX, pos.x - padX);
      maxX = Math.max(maxX, pos.x + padX);
      minY = Math.min(minY, pos.y - padTop);
      maxY = Math.max(maxY, pos.y + padBottom);
    }

    const overflowLeft = -minX;
    const overflowRight = maxX - WIDTH;
    const overflowTop = -minY;
    const overflowBottom = maxY - HEIGHT;
    const hasLeft = overflowLeft > 0;
    const hasRight = overflowRight > 0;
    const hasTop = overflowTop > 0;
    const hasBottom = overflowBottom > 0;

    if (!hasLeft && !hasRight && !hasTop && !hasBottom) {
      return positions;
    }

    if ((hasLeft && hasRight) || (hasTop && hasBottom)) {
      radius = Math.max(PICKER_MIN_RADIUS, radius - 3);
      continue;
    }

    if (hasLeft) cx += overflowLeft;
    if (hasRight) cx -= overflowRight;
    if (hasTop) cy += overflowTop;
    if (hasBottom) cy -= overflowBottom;
  }

  return measureFanPositions(cx, cy, count, radius, PICKER_FAN_START, PICKER_FAN_END);
}

function getPickerWeaponPositions() {
  return fitPickerFanPositions(
    deployPicker.anchorX,
    deployPicker.anchorY,
    WEAPON_TYPES.length,
    PICKER_WEAPON_RADIUS
  );
}

function getPickerElementPositions() {
  if (deployPicker.weaponIndex < 0) return [];
  const weaponPos = getPickerWeaponPositions()[deployPicker.weaponIndex];
  return fitPickerFanPositions(
    weaponPos.x,
    weaponPos.y,
    ELEMENT_TYPES.length,
    PICKER_ELEMENT_RADIUS
  );
}

function findPickerOptionIndex(px, py, positions) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < positions.length; i += 1) {
    const dx = px - positions[i].x;
    const dy = py - positions[i].y;
    const dist = Math.hypot(dx, dy);
    if (dist <= PICKER_HIT_RADIUS && dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function resetDeployPicker() {
  deployPicker.active = false;
  deployPicker.phase = "weapon";
  deployPicker.pointerId = null;
  deployPicker.weaponIndex = -1;
  deployPicker.weaponType = null;
  deployPicker.elementIndex = -1;
  deployPicker.elementType = null;
}

function startDeployPicker(pointerId, clientX, clientY) {
  const point = clientToCanvas(clientX, clientY);
  if (!isInDeployZone(point.y)) return false;

  const lane = getLaneFromCanvasX(point.x);
  if (state.allies.some((ally) => ally.lane === lane)) {
    setStatus("そのレーンには既に味方がいます。");
    return false;
  }

  deployPicker.active = true;
  deployPicker.phase = "weapon";
  deployPicker.pointerId = pointerId;
  deployPicker.anchorX = laneCenterX(lane);
  deployPicker.anchorY = point.y;
  deployPicker.pointerX = point.x;
  deployPicker.pointerY = point.y;
  deployPicker.lane = lane;
  deployPicker.weaponIndex = -1;
  deployPicker.weaponType = null;
  deployPicker.elementIndex = -1;
  deployPicker.elementType = null;
  setStatus("兵科をドラッグで選択...");
  return true;
}

function updateDeployPicker(clientX, clientY) {
  if (!deployPicker.active) return;
  const point = clientToCanvas(clientX, clientY);
  deployPicker.pointerX = point.x;
  deployPicker.pointerY = point.y;

  if (deployPicker.phase === "weapon") {
    const weaponIndex = findPickerOptionIndex(point.x, point.y, getPickerWeaponPositions());
    if (weaponIndex >= 0) {
      deployPicker.weaponIndex = weaponIndex;
      deployPicker.weaponType = WEAPON_TYPES[weaponIndex];
      deployPicker.phase = "element";
      deployPicker.elementIndex = -1;
      deployPicker.elementType = null;
      setStatus("属性をドラッグで選択...");
    }
    return;
  }

  const elementIndex = findPickerOptionIndex(point.x, point.y, getPickerElementPositions());
  deployPicker.elementIndex = elementIndex;
  deployPicker.elementType = elementIndex >= 0 ? ELEMENT_TYPES[elementIndex] : null;
}

function finishDeployPicker() {
  if (!deployPicker.active) return;
  const { lane, weaponType, elementType } = deployPicker;
  const completed = weaponType && elementType;
  resetDeployPicker();
  if (completed) {
    deployUnitToLane(lane, weaponType, elementType);
  } else {
    setStatus("配置をキャンセルしました。");
  }
}

function drawPickerOption(x, y, label, entity, highlighted, locked) {
  const radius = PICKER_HIT_RADIUS + 4;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = locked ? "rgba(255, 209, 102, 0.28)" : "rgba(24, 24, 48, 0.88)";
  ctx.fill();
  ctx.strokeStyle = highlighted || locked ? "#ffd166" : "#8a8ab0";
  ctx.lineWidth = highlighted || locked ? 2 : 1;
  ctx.stroke();

  const img = getUnitImage(entity);
  if (img) {
    const scale = PICKER_ICON_HEIGHT / img.naturalHeight;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(x), Math.round(y - 4));
    ctx.drawImage(img, Math.round(-w / 2), Math.round(-h), w, h);
    ctx.restore();
  }

  ctx.fillStyle = "#f8f8f8";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(label, Math.round(x), Math.round(y + radius - 2));
}

function drawDeployPicker() {
  if (!deployPicker.active) return;

  const weaponPositions = getPickerWeaponPositions();
  const elementPositions = deployPicker.phase === "element" ? getPickerElementPositions() : [];

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 1;
  for (const pos of weaponPositions) {
    ctx.beginPath();
    ctx.moveTo(deployPicker.anchorX, deployPicker.anchorY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }
  if (deployPicker.phase === "element" && deployPicker.weaponIndex >= 0) {
    const weaponPos = weaponPositions[deployPicker.weaponIndex];
    for (const pos of elementPositions) {
      ctx.beginPath();
      ctx.moveTo(weaponPos.x, weaponPos.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
  }

  for (let i = 0; i < WEAPON_TYPES.length; i += 1) {
    const weaponType = WEAPON_TYPES[i];
    const pos = weaponPositions[i];
    const highlighted =
      deployPicker.phase === "weapon" && findPickerOptionIndex(deployPicker.pointerX, deployPicker.pointerY, [pos]) >= 0;
    const locked = deployPicker.weaponIndex === i;
    drawPickerOption(
      pos.x,
      pos.y,
      `${weaponLabels[weaponType]}兵`,
      { weaponType, elementType: "fire" },
      highlighted,
      locked
    );
  }

  if (deployPicker.phase === "element") {
    for (let i = 0; i < ELEMENT_TYPES.length; i += 1) {
      const elementType = ELEMENT_TYPES[i];
      const pos = elementPositions[i];
      const highlighted = deployPicker.elementIndex === i;
      drawPickerOption(
        pos.x,
        pos.y,
        elementLabels[elementType],
        { weaponType: deployPicker.weaponType, elementType },
        highlighted,
        highlighted
      );
    }
  }

  ctx.beginPath();
  ctx.arc(deployPicker.anchorX, deployPicker.anchorY, 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 209, 102, 0.9)";
  ctx.fill();
  ctx.restore();
}

function loadMapBackground() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      mapBackgroundImage = img;
      resolve();
    };
    img.onerror = () => resolve();
    img.src = MAP_BACKGROUND_PATH;
  });
}

function buildMapBackground() {
  const bg = document.createElement("canvas");
  bg.width = WIDTH;
  bg.height = HEIGHT;
  const bctx = bg.getContext("2d");

  if (mapBackgroundImage && mapBackgroundImage.naturalWidth > 0) {
    const img = mapBackgroundImage;
    const scale = Math.max(WIDTH / img.naturalWidth, HEIGHT / img.naturalHeight);
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const drawX = (WIDTH - drawW) / 2;
    const drawY = (HEIGHT - drawH) / 2;
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(img, drawX, drawY, drawW, drawH);
  } else {
    bctx.fillStyle = "#4f9a47";
    bctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  bctx.fillStyle = "rgba(0, 0, 0, 0.12)";
  bctx.fillRect(0, DEPLOY_ZONE_TOP - 2, WIDTH, 4);

  mapBackgroundCanvas = bg;
}

function drawLaneBackground() {
  if (mapBackgroundCanvas) {
    ctx.drawImage(mapBackgroundCanvas, 0, 0);
    return;
  }
  ctx.fillStyle = "#4f9a47";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawHpBar(entity, render, width = 28, position = "top") {
  const ratio = Math.max(0, entity.hp / entity.maxHp);
  const barH = 4;
  const border = 1;
  const barY = position === "bottom" ? render.feetY + 4 : render.feetY - getUnitHeight(entity) * render.scaleY - 8;
  const barX = render.x - width / 2;

  ctx.fillStyle = "#111111";
  ctx.fillRect(barX - border, barY - border, width + border * 2, barH + border * 2);
  ctx.fillStyle = "#2f3640";
  ctx.fillRect(barX, barY, width, barH);
  ctx.fillStyle = getHpBarColor(ratio);
  ctx.fillRect(barX, barY, width * ratio, barH);
}

function getUnitHeight(entity) {
  const img = getUnitImage(entity);
  return img ? img.naturalHeight : 40;
}

function drawAllies() {
  for (const ally of state.allies) {
    const render = getUnitRenderState(ally);
    drawUnitSprite(ally, render);
    drawHpBar(ally, render, 28, "bottom");
  }
}

function drawEnemies() {
  for (const enemy of state.enemies) {
    const render = getUnitRenderState(enemy);
    drawUnitSprite(enemy, render);
    drawHpBar(enemy, render, 28);
  }
}

function drawGameOver() {
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#f8f8f8";
  ctx.textAlign = "center";
  ctx.font = "bold 26px sans-serif";
  ctx.fillText("GAME OVER", WIDTH / 2, HEIGHT / 2 - 10);
  ctx.font = "14px sans-serif";
  ctx.fillText("ページを再読み込みして再挑戦", WIDTH / 2, HEIGHT / 2 + 18);
}

function render() {
  drawLaneBackground();
  drawAllies();
  drawEnemies();
  drawDeployPicker();
  if (state.over) drawGameOver();
}

function getTurnProgress() {
  if (state.turnTimer >= MOVE_DURATION) return 1;
  const t = state.turnTimer / MOVE_DURATION;
  return 1 - (1 - t) * (1 - t);
}

function updateHoldDurationFromSlider() {
  holdDuration = Number(holdDurationSlider.value);
  holdDurationValueEl.textContent = holdDuration.toFixed(2);
}

function getHoldPhaseTime() {
  return Math.max(0, state.turnTimer - MOVE_DURATION);
}

function getAttackLungeDistance(entity) {
  if (!entity.attackTarget) return 0;
  const gap = Math.abs(entity.attackTarget.y - entity.y);
  return Math.max(0, gap - MIN_ATTACK_GAP);
}

function getAttackOffsetY(entity) {
  if (!entity.hadAttack) return 0;
  const t = getHoldPhaseTime();
  if (t >= ATTACK_ANIM_DURATION) return 0;
  const half = ATTACK_ANIM_DURATION / 2;
  const progress = t < half ? t / half : 1 - (t - half) / half;
  return entity.attackDir * getAttackLungeDistance(entity) * progress;
}

function getUnitRenderState(entity) {
  const progress = getTurnProgress();
  const groundCenterY = entity.prevY + (entity.y - entity.prevY) * progress;
  const moving = entity.prevY !== entity.y && state.turnTimer < MOVE_DURATION;
  let scaleX = 1;
  let scaleY = 1;
  let air = 0;

  if (moving) {
    air = Math.sin(Math.PI * progress);
    scaleX = 1 + JUMP_SCALE_X * air;
    scaleY = 1 + JUMP_SCALE_Y * air;
  }

  const h = getUnitHeight(entity);
  const feetY = groundCenterY + h / 2 - JUMP_LIFT * air + getAttackOffsetY(entity);

  return {
    x: entity.x,
    feetY,
    scaleX,
    scaleY,
    air
  };
}

function resolveTurn() {
  clearAttackAnims();
  markPreviousPosition();
  state.turnCount += 1;
  updateSpawnTurn();
  moveAlliesOneCell();
  moveEnemiesOneCell();
  normalizeMeleeStandoff();
  scheduleMeleeCombat();
  maybeAdvanceWave();
}

let lastTime = performance.now();
function loop(nowMs) {
  const now = nowMs / 1000;
  const dt = Math.min(0.033, now - lastTime / 1000);
  lastTime = nowMs;

  if (!state.over) {
    updateSpawn(dt);
    updateEnemies(dt);
    updateAllies(now);
    state.turnTimer += dt;
    applyPendingAttackDamage();
    resolveDefeatsAfterDamage();

    while (state.turnTimer >= getTurnCycle() && !state.over) {
      applyPendingAttackDamage(true);
      resolveDefeatsAfterDamage();
      state.turnTimer -= getTurnCycle();
      resolveTurn();
    }

    if (state.baseHp <= 0) {
      state.baseHp = 0;
      state.over = true;
      setStatus("拠点が陥落しました。");
    }
    updateHUD();
  }

  render();
  requestAnimationFrame(loop);
}

function onCanvasPointerDown(event) {
  if (state.over) return;
  if (deployPicker.active) return;
  if (startDeployPicker(event.pointerId, event.clientX, event.clientY)) {
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
}

function onCanvasPointerMove(event) {
  if (!deployPicker.active || deployPicker.pointerId !== event.pointerId) return;
  updateDeployPicker(event.clientX, event.clientY);
  event.preventDefault();
}

function onCanvasPointerUp(event) {
  if (!deployPicker.active || deployPicker.pointerId !== event.pointerId) return;
  updateDeployPicker(event.clientX, event.clientY);
  finishDeployPicker();
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  event.preventDefault();
}

canvas.addEventListener("pointerdown", onCanvasPointerDown);
canvas.addEventListener("pointermove", onCanvasPointerMove);
canvas.addEventListener("pointerup", onCanvasPointerUp);
canvas.addEventListener("pointercancel", onCanvasPointerUp);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("selectstart", (event) => event.preventDefault());

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsToggle.setAttribute("aria-label", open ? "設定を閉じる" : "設定を開く");
}

function initSettingsPanel() {
  setSettingsOpen(false);
  settingsToggle.addEventListener("click", () => {
    setSettingsOpen(settingsPanel.hidden);
  });
  settingsClose.addEventListener("click", () => {
    setSettingsOpen(false);
  });
}

holdDurationSlider.addEventListener("input", updateHoldDurationFromSlider);

function syncViewportHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

function initViewportSync() {
  syncViewportHeight();
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.visualViewport?.addEventListener("scroll", syncViewportHeight);
  window.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
}

function init() {
  initViewportSync();
  initSettingsPanel();
  updateHoldDurationFromSlider();
  updateHUD();
  setStatus("画像を読み込み中...");
  Promise.all([loadMapBackground(), loadUnitImages()])
    .then(() => {
      buildMapBackground();
      setStatus("下部レーンを押して兵科→属性をドラッグ選択し、離して配置。");
      requestAnimationFrame(loop);
    })
    .catch(() => {
      buildMapBackground();
      setStatus("ユニット画像の読み込みに失敗しました。");
    });
}

init();
