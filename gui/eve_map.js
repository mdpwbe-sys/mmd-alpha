/* Offline New Eden graph.  Positions are fixed from CCP's physical coordinates. */
(function () {
  const state = { graph: null, data: null, routePreferences: { entries: [], avoid_incursions: false, avoid_recent_hotspots: false }, nodesById: null, renderNodes: [], trafficBySystem: new Map(), gateFlows: null, gateDegrees: new Map(), labelGroups: null, labelHitTargets: [], labelLod: { mode: 'constellation', initialized: false, opacity: { system: 0, constellation: 1, region: 0 } }, labelVisibility: new Map(), intelLabelMetric: 'none', intelLabelValues: new Map(), intelLabelDistributions: {}, worldEvents: { events: [], state: 'unavailable' }, eventFilter: 'all', graphicsQuality: 'normal', pointer: null, suppressNodeClickUntil: 0, linkCanvas: null, skyCanvas: null, skyField: null, skyRays: null, skyTexture: null, skyTextureImage: null, skyTextureUrl: null, skyTextureLoading: false, skyStars: [], skyFrameKey: null, skyLastPaintAt: 0, skyInteracting: false, nodeScaleKey: null, linkFrame: null, overlayDirty: new Set(), cameraAnimating: false, cameraIdleTimer: null, perf: { overlayFrames: 0, gateProjections: 0, labelDraws: 0, skyDraws: 0, combatDraws: 0, scheduledFrames: 0, cameraSyncs: 0, combatPolls: 0, combatStateChanges: 0, intelLabelRebuilds: 0, intelLabelRebuildMs: 0 }, resizeMap: null, resizeObserver: null, lastLinkDraw: 0, visible: false, route: null, originId: null, destinationId: null, lastNodeClick: null, hoverCandidate: null, killHoverKey: null, killPopover: null, killPopoverHideTimer: null, panelSelection: null, panelCollapsed: false, panelSections: { info: true, intel: true, route: true, alert: true, events: true }, characters: [], characterTrackingTimer: null, combatMarkerTimer: null, combatMarkers: new Map(), showCombatHotspots: true, areaKillHistory: new Map(), intelAlert: { enabled: false, radius_jumps: 5, sound_enabled: true, tracked_character_ids: [] }, intelAlertToastTimer: null, live: { systems: {}, state: 'unavailable', updated_at: null }, sovereignty: { systems: {}, state: 'unavailable', updated_at: null }, filters: { high: true, low: true, null: true, wspace: false, gates: true, traffic: false, danger: false, sovereignty: false, empires: false } };
  const byId = () => new Map((state.data && state.data.systems || []).map(s => [s.id, s]));
  const api = () => window.pywebview && window.pywebview.api || window.api;
  const mapWorkspace = () => document.getElementById('eve-map-workspace') || document.getElementById('eve-map-overlay');
  const HIGHSEC_THRESHOLD = .45;
  const security = s => s >= HIGHSEC_THRESHOLD ? 'high' : s > 0 ? 'low' : 'null';
  // Keep the High / Low / Null classes for filters and routing, but render the
  // base node colour from the one-decimal security value players see in EVE.
  const securityColor = securityStatus => {
    const displayed = Math.round(Math.max(-1, Math.min(1, Number(securityStatus) || 0)) * 10) / 10;
    if (displayed >= 1) return '#54dce8';
    if (displayed >= .9) return '#50ddd5';
    if (displayed >= .8) return '#45dfc8';
    if (displayed >= .7) return '#63d985';
    if (displayed >= .6) return '#8bd577';
    if (displayed >= .5) return '#b3d56b';
    if (displayed >= .4) return '#e8cf62';
    if (displayed >= .3) return '#ef8249';
    if (displayed >= .2) return '#e45d5d';
    if (displayed >= .1) return '#d34e52';
    return ['#ca495b', '#bf4666', '#b44371', '#a7407c', '#993d86', '#8b3b8c', '#7c398d', '#6e3687', '#61337f', '#553077', '#4b2c6b'][Math.round(-displayed * 10)];
  };
  // Cosmetic variants keyed by SDE region IDs; never used by filters/routing.
  const SPECIAL_REGION_COLORS = Object.freeze({
    10000070: '#a84b68', // Pochven: muted crimson.
    10000017: '#7277ae', 10000019: '#7277ae', // J7HZ-F / A821-A: Jove.
    10000004: '#656582', // UUA-F4: separate special-region variant.
  });
  const systemSecurityColor = node => Number(node.region_id) >= 11000000 && Number(node.region_id) < 12000000
    ? '#39254f' : SPECIAL_REGION_COLORS[Number(node.region_id)] || securityColor(node.security);
  const mutedSecurityColor = securityStatus => {
    const hex = securityColor(securityStatus).slice(1);
    const channels = [0, 2, 4].map(offset => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * .46));
    return `rgb(${channels.join(', ')})`;
  };
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const CHARACTER_COLORS = ['#66e7f5', '#ffca62', '#e978b1', '#aa8cff', '#7ee6a9', '#ff956e'];
  const CHARACTER_POSITION_POLL_MS = 15_000;
  const COMBAT_MARKER_TTL_MS = 30 * 60 * 1000;
  const MAP_HOVER_DELAY_MS = 1_000;
  const MUSIC_DEFAULT_VOLUME = .30;
  // Temporary A/B switch for the 1 FPS regression. Opening New Eden must not
  // call the native audio bridge at all; manual Play remains available.
  const MUSIC_AUTOSTART_ENABLED = false;
  const MUSIC_DUCK_HOLD_MS = 3_000;
  const musicDuckMultiplier = distanceJumps => distanceJumps <= 1 ? .15 : distanceJumps <= 3 ? .35 : .60;
  const musicDuckingPlan = distanceJumps => ({
    multiplier: musicDuckMultiplier(distanceJumps), fadeDownMs: 250,
    holdMs: MUSIC_DUCK_HOLD_MS, fadeUpMs: 2_000,
  });
  const musicVisibilityPlan = visible => ({ fadeMs: visible ? 2_500 : 600, pause: !visible });
  // The bridge owns playback so Windows creates an actual application audio
  // session.  This UI state deliberately never creates a second audio player.
  const newEdenMusic = { available: null, playing: false, visible: false, manuallyPaused: false, userVolume: MUSIC_DEFAULT_VOLUME, duckMultiplier: 1, shuffle: false, starting: false, track: null, trackIndex: 0, playlist: [], playlistCount: 0, error: null };
  const characterPositionTrackingInterval = visible => visible ? CHARACTER_POSITION_POLL_MS : null;
  const characterColorInfo = character => {
    const dashboardColor = window.getCharColorInfo?.(character?.name);
    if (dashboardColor?.color) return dashboardColor;
    const color = CHARACTER_COLORS[Math.abs(Number(character?.character_id) || 0) % CHARACTER_COLORS.length];
    return { color, glow: color };
  };
  const characterColor = character => characterColorInfo(character).color;
  const characterRingSegments = characters => {
    const count = Math.max(1, characters.length), sweep = (Math.PI * 2) / count, gap = count === 1 ? 0 : Math.min(.075, sweep * .16);
    return characters.map((character, index) => ({
      character, ...characterColorInfo(character),
      start: -Math.PI / 2 + index * sweep + gap / 2,
      end: -Math.PI / 2 + (index + 1) * sweep - gap / 2,
    }));
  };
  const activeCharacters = (characters = state.characters, selectedCharacterId = state.selectedCharacterId) => (
    characters.filter(character => !selectedCharacterId || String(character.character_id) === String(selectedCharacterId))
  );
  const activeCharacterSystemIds = (characters = state.characters, selectedCharacterId = state.selectedCharacterId) => (
    new Set(activeCharacters(characters, selectedCharacterId).map(character => Number(character.system_id)))
  );
  const characterGroups = () => {
    const groups = new Map();
    activeCharacters().forEach(character => {
      const group = groups.get(character.system_id) || [];
      group.push(character); groups.set(character.system_id, group);
    });
    return groups;
  };
  const visibleCharacterIds = () => [...characterGroups().values()].flat().map(character => character.character_id).sort((left, right) => left - right);
  const CAPSULE_TYPE_ID = 670;
  const isPodMarker = marker => Number(marker?.victim_ship_type_id) === CAPSULE_TYPE_ID || /\bcapsule\b/i.test(String(marker?.victim_ship_name || ''));
  const superscriptNumber = value => String(Math.max(0, Number(value) || 0)).replace(/\d/g, digit => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]);
  function combatDangerScore(combat) {
    const summary = typeof combat === 'object' && combat ? combat : { kills: combat, pods: 0 };
    const kills = Math.max(0, Number(summary.kills ?? summary.count) || 0);
    const pods = Math.min(kills, Math.max(0, Number(summary.pods ?? summary.pod_count) || 0));
    // A capsule loss is a stronger tactical signal than an ordinary ship loss:
    // ganks and smartbomb camps should light up immediately, before the next
    // ESI 24-hour aggregate refresh.
    const weightedKills = (kills - pods) + pods * 2.5;
    if (weightedKills >= 10) return 100;
    if (weightedKills >= 5) return 85;
    if (weightedKills >= 2) return 55;
    return weightedKills ? 20 : 0;
  }
  function dangerBandForScore(score) { return score >= 75 ? 'red' : score >= 50 ? 'orange' : score >= 20 ? 'yellow' : 'normal'; }
  function recentCombatSummary(systemId, now = Date.now()) {
    const summary = { kills: 0, pods: 0 };
    for (const marker of state.combatMarkers.values()) {
      if (Number(marker?.system_id) !== Number(systemId) || now >= Number(marker.expiresAt)) continue;
      summary.kills += 1;
      if (isPodMarker(marker)) summary.pods += 1;
    }
    return summary;
  }
  const liveWithCombat = (base, combat) => {
    const summary = typeof combat === 'object' && combat ? combat : { kills: combat, pods: 0 };
    const recentKills = Math.max(0, Number(summary.kills ?? summary.count) || 0), recentPods = Math.min(recentKills, Math.max(0, Number(summary.pods ?? summary.pod_count) || 0));
    const streamDanger = combatDangerScore({ kills: recentKills, pods: recentPods }), danger = Math.max(Number(base?.danger) || 0, streamDanger);
    return { ...(base || {}), ship_jumps: Number(base?.ship_jumps) || 0, ship_kills: Number(base?.ship_kills) || 0, pod_kills: Number(base?.pod_kills) || 0, npc_kills: Number(base?.npc_kills) || 0, recent_combat_kills: recentKills, recent_combat_pods: recentPods, danger, danger_band: dangerBandForScore(danger) };
  };
  const liveFor = system => liveWithCombat(state.live.systems[String(system?.id)] || {}, recentCombatSummary(system?.id));
  // On-demand planner snapshot only: same final scores/bands as the map,
  // no fetch, no new score formula, no per-frame work.
  window.getEveMapJumpDangerSnapshot = () => {
    const systems = {};
    for (const system of state.data?.systems || []) {
      const live = liveFor(system);
      const base = state.live.systems[String(system.id)];
      if (Number.isFinite(base?.danger) || live.recent_combat_kills > 0)
        systems[system.id] = { score: live.danger, band: live.danger_band,
          esi_score:Number(base?.danger)||0,
          recent_score:combatDangerScore({kills:live.recent_combat_kills,pods:live.recent_combat_pods}) };
    }
    return { systems, observed_at: Date.now()/1000, state: state.live.state };
  };
  const sovereigntyFor = system => state.sovereignty.systems[String(system?.id)] || {};
  function influenceLayers(node, filters = state.filters, sovereignty = sovereigntyFor(node)) {
    const layers = [];
    const playerSovereignId = sovereignty.alliance_id || sovereignty.corporation_id;
    // Empires & NPC is static SDE data.  It must not disappear merely because
    // a previously loaded public Sov cache happens to know an owner here.
    if (filters.empires && node.faction_id) layers.push({ id: node.faction_id, alpha: .40, kind: 'empire', offset: layers.length });
    // CCP's sovereignty payload also contains faction-owned systems. Player
    // Sov intentionally means only player alliances/corporations in null-sec.
    if (filters.sovereignty && security(node.security) === 'null' && playerSovereignId) layers.push({ id: playerSovereignId, alpha: sovereignty.alliance_id ? .40 : .32, kind: 'sovereignty', offset: layers.length });
    return layers;
  }
  const FACTION_COLORS = { 500001: '#64aefb', 500002: '#e95768', 500003: '#e4bf65', 500004: '#60d99a', 500005: '#b493f2', 500007: '#8d99a7' };
  const influenceColor = id => {
    const known = FACTION_COLORS[Number(id)]; if (known) return known;
    const hue = Math.abs(Number(id) || 0) % 360;
    return `hsl(${hue} 70% 66%)`;
  };
  // The New Eden map uses Y as its up axis.  Keep the panoramic sky in that
  // same frame, with a deliberate quarter-turn yaw so its Milky-Way band wraps
  // around the map rather than cutting across the default overhead shot.
  const SKY_TEXTURE_YAW = Math.PI / 2;
  const SKY_POLE_MARGIN = .035;
  // The left mouse orbit is intentionally free across New Eden.  Only a tiny
  // epsilon avoids the mathematically singular exact pole; right-click panning
  // remains locked to the camera screen plane independently.
  const NEW_EDEN_MIN_POLAR_ANGLE = .01;
  const NEW_EDEN_MAX_POLAR_ANGLE = Math.PI - .01;
  // The ESO panorama is already equirectangular.  WebP keeps the 4K source
  // crisp while avoiding the 72+ MiB decoded cost of the original 6000x3000 TIFF.
  const GRAPHICS_PROFILES = Object.freeze({
    off: Object.freeze({ quality: 'off', skyTextureUrl: null, skyDpr: 0, skyScale: 0, nebulaEnabled: false, nearStarsEnabled: false, decorativeStars: 0, decorativeGlow: 0, labelGlow: 0, trafficParticleBudget: 1, trafficGlow: 0 }),
    normal: Object.freeze({ quality: 'normal', skyTextureUrl: 'data/sky/new-eden-sky-milky-way-4096.webp', skyDpr: 1, skyScale: 1, nebulaEnabled: true, nearStarsEnabled: true, decorativeStars: 3000, decorativeGlow: 1, labelGlow: 1, trafficParticleBudget: 3, trafficGlow: 1 }),
    low: Object.freeze({ quality: 'low', skyTextureUrl: 'data/sky/new-eden-sky-milky-way-1024.webp', skyDpr: .70, skyScale: .48, nebulaEnabled: false, nearStarsEnabled: false, decorativeStars: 280, decorativeGlow: 1, labelGlow: .45, trafficParticleBudget: 1, trafficGlow: .42 }),
  });
  const normalizeGraphicsQuality = value => ['off', 'low', 'normal'].includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'normal';
  const graphicsProfile = quality => GRAPHICS_PROFILES[normalizeGraphicsQuality(quality)];
  const currentGraphicsProfile = () => graphicsProfile(state.graphicsQuality);
  const SKY_MOVING_FRAME_MS = 110;
  const SKY_SETTLED_FRAME_MS = 72;
  const SKY_TAU = Math.PI * 2;
  const SKY_GPU_MAX_DPR = 1;
  const SKY_GPU_MOVING_SCALE = .72;
  const SKY_GPU_SETTLED_SCALE = 1;
  const SKY_GPU_VERTEX_SHADER = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = aPosition * .5 + .5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  const SKY_GPU_FRAGMENT_SHADER = `
    precision highp float;
    uniform mat3 uCameraRotation;
    uniform mat2 uWorldToSky;
    uniform vec2 uInverseFocal;
    uniform sampler2D uSkyTexture;
    uniform float uSkyDebugMode;
    uniform float uDecorations;
    varying vec2 vUv;
    const float PI = 3.141592653589793;
    // One deterministic candidate per cube-face cell.  This keeps the nearby
    // stellar shell even over the poles, without a CPU star list or a second
    // canvas to repaint while the camera moves.
    vec3 hash33(vec3 value) {
      value = fract(value * vec3(.1031, .11369, .13787));
      value += dot(value, value.yxz + 19.19);
      return fract((value.xxy + value.yzz) * value.zyx);
    }
    vec2 cubeFaceUv(vec3 direction, out float face) {
      vec3 magnitude = abs(direction);
      vec2 coordinate;
      if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
        float inverseAxis = 1.0 / max(magnitude.x, .0001);
        if (direction.x >= 0.0) { face = 0.0; coordinate = vec2(-direction.z, direction.y) * inverseAxis; }
        else { face = 1.0; coordinate = vec2(direction.z, direction.y) * inverseAxis; }
      } else if (magnitude.y >= magnitude.z) {
        float inverseAxis = 1.0 / max(magnitude.y, .0001);
        if (direction.y >= 0.0) { face = 2.0; coordinate = vec2(direction.x, -direction.z) * inverseAxis; }
        else { face = 3.0; coordinate = vec2(direction.x, direction.z) * inverseAxis; }
      } else {
        float inverseAxis = 1.0 / max(magnitude.z, .0001);
        if (direction.z >= 0.0) { face = 4.0; coordinate = vec2(direction.x, direction.y) * inverseAxis; }
        else { face = 5.0; coordinate = vec2(-direction.x, direction.y) * inverseAxis; }
      }
      return coordinate * .5 + .5;
    }
    vec3 nearStarLayer(vec2 faceUv, float face, float cells, float density, float radius, float seed) {
      vec2 cellCoordinate = faceUv * cells;
      vec2 cell = floor(cellCoordinate);
      vec2 localCoordinate = fract(cellCoordinate);
      vec3 candidate = hash33(vec3(cell, face * 29.17 + seed));
      float exists = 1.0 - step(density, candidate.z);
      vec2 starCoordinate = mix(vec2(.30), vec2(.70), candidate.xy);
      float distanceToStar = length(localCoordinate - starCoordinate);
      float core = 1.0 - smoothstep(radius * .38, radius, distanceToStar);
      float wing = 1.0 - smoothstep(radius, radius * 1.7, distanceToStar);
      float luminosity = .22 + .38 * inversesqrt(sqrt(max(candidate.x, .025)));
      float warm = smoothstep(.62, .97, candidate.y);
      vec3 tint = mix(vec3(.52, .70, 1.0), vec3(1.0, .69, .44), warm);
      return tint * exists * (core + wing * .055) * luminosity;
    }
    // Stable direction -> broad warped cloud mass -> density and colour.
    // This deliberately avoids periodic longitude bands: the panorama owns the
    // distant detail while this field only adds a few natural-looking gas veils.
    float hash31(vec3 point) {
      point = fract(point * .1031);
      point += dot(point, point.yzx + 33.33);
      return fract((point.x + point.y) * point.z);
    }
    float valueNoise3(vec3 point) {
      vec3 cell = floor(point), local = fract(point);
      local = local * local * (3.0 - 2.0 * local);
      float a = hash31(cell + vec3(0., 0., 0.)), b = hash31(cell + vec3(1., 0., 0.));
      float c = hash31(cell + vec3(0., 1., 0.)), d = hash31(cell + vec3(1., 1., 0.));
      float e = hash31(cell + vec3(0., 0., 1.)), f = hash31(cell + vec3(1., 0., 1.));
      float g = hash31(cell + vec3(0., 1., 1.)), h = hash31(cell + vec3(1., 1., 1.));
      return mix(mix(mix(a, b, local.x), mix(c, d, local.x), local.y), mix(mix(e, f, local.x), mix(g, h, local.x), local.y), local.z);
    }
    vec3 nebulaDirection(vec3 direction) {
      vec3 warp = vec3(valueNoise3(direction * 1.13 + vec3(13.7, 2.1, 7.9)), valueNoise3(direction * 1.13 + vec3(3.4, 19.2, 11.6)), valueNoise3(direction * 1.13 + vec3(8.1, 6.3, 23.4))) - .5;
      return normalize(direction + warp * .26);
    }
    float nebulaDensity(vec3 direction) {
      vec3 warped = nebulaDirection(direction);
      float macro = valueNoise3(warped * 1.62 + vec3(4.7, 9.1, 2.5));
      float meso = valueNoise3(warped * 4.20 + vec3(12.6, 3.8, 16.2));
      float galacticSheet = 1.0 - smoothstep(.18, .56, abs(dot(warped, normalize(vec3(.18, .91, -.37)))));
      return galacticSheet * smoothstep(.58, .78, macro * .68 + meso * .32);
    }
    void main() {
      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 viewDirection = normalize(vec3(ndc.x * uInverseFocal.x, ndc.y * uInverseFocal.y, -1.0));
      vec3 worldDirection = uCameraRotation * viewDirection;
      vec2 skyXZ = uWorldToSky * worldDirection.xz;
      vec3 skyDirection = vec3(skyXZ.x, worldDirection.y, skyXZ.y);
      float longitude = .5 + atan(skyDirection.z, skyDirection.x) / (2.0 * PI);
      float latitude = .5 - asin(clamp(skyDirection.y, -1.0, 1.0)) / PI;
      vec3 distantSky = texture2D(uSkyTexture, vec2(fract(longitude), clamp(latitude, 0.0, 1.0))).rgb;
      distantSky = pow(max(distantSky, vec3(0.0)), vec3(1.16)) * .70;
      float darkSpace = 1.0 - smoothstep(.16, .72, max(distantSky.r, max(distantSky.g, distantSky.b)));
      float nebula = 0.0;
      vec3 gasNebula = vec3(0.0);
      if (uDecorations > .5) {
        vec3 warpedNebulaDirection = nebulaDirection(skyDirection);
        nebula = nebulaDensity(skyDirection);
        float warmPocket = smoothstep(.52, .82, valueNoise3(warpedNebulaDirection * 2.15 + vec3(3.1, 14.7, 8.5))) * nebula;
        gasNebula = vec3(.018, .078, .145) * nebula;
        gasNebula += vec3(.095, .020, .062) * warmPocket;
      }
      // Two sparse layers create nearby, crisp depth cues while the panorama
      // owns the distant Milky-Way detail and the ribbons stay a light accent.
      float nearFace;
      vec2 nearFaceUv = cubeFaceUv(skyDirection, nearFace);
      vec3 nearbyStars = vec3(0.0);
      if (uDecorations > .5) {
        nearbyStars = nearStarLayer(nearFaceUv, nearFace, 164.0, .048, .125, 3.0);
        nearbyStars += nearStarLayer(nearFaceUv, nearFace, 72.0, .025, .15, 31.0);
        nearbyStars += nearStarLayer(nearFaceUv, nearFace, 36.0, .007, .19, 67.0);
      }
      if (uSkyDebugMode > 1.5) { gl_FragColor = vec4(nearbyStars * 1.8, 1.0); return; }
      if (uSkyDebugMode > .5) { gl_FragColor = vec4(vec3(nebula), 1.0); return; }
      gl_FragColor = vec4(distantSky + gasNebula * (.20 + darkSpace * .46) + nearbyStars * .68, 1.0);
    }
  `;
  const rotateSkyYaw = (direction, angle) => {
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    return { x: direction.x * cosine + direction.z * sine, y: direction.y, z: -direction.x * sine + direction.z * cosine };
  };
  const skyTextureDirection = direction => rotateSkyYaw(direction, -SKY_TEXTURE_YAW);
  const worldSkyDirection = direction => rotateSkyYaw(direction, SKY_TEXTURE_YAW);
  const tacticalOverlays = { reachableSystemIds: [], cynos: [], midpoints: [], plannedJumpLegs: [], unreachableSystemIds: [] };
  let physicalJumpView=null, jumpSphere=null, jumpExpiryTimer=null;
  function scheduleJumpExpiry() {
    clearTimeout(jumpExpiryTimer);jumpExpiryTimer=null;
    const now=Date.now();
    const future=(state.jumpRouteState?.cynos||[]).map(c=>Number(c.observed_at)*1000+30001).filter(at=>at>now);
    if(future.length)jumpExpiryTimer=setTimeout(()=>{markOverlayDirty('jump-position-expired');scheduleJumpExpiry();},Math.min(...future)-now);
  }
  window.setEveMapJumpRoute = payload => {
    state.jumpRouteState=payload; // Shared object, not a Physical/Tactical clone.
    scheduleJumpExpiry();
    window.EveJumpOverlay?.disposeSphere(jumpSphere);jumpSphere=null;
    physicalJumpView=state.physicalTransform&&window.EveJumpOverlay
      ?window.EveJumpOverlay.physicalView(payload,state.physicalTransform):null;
    if(physicalJumpView?.range&&state.graph) {
      const sample=state.physicalNodes?.find(n=>n.__threeObj?.geometry?.type==='SphereGeometry')?.__threeObj;
      jumpSphere=window.EveJumpOverlay.sphere(sample,physicalJumpView.range,window.EveMapStyles.registry.JUMP_RANGE);
      if(jumpSphere){jumpSphere.visible=state.layoutMode!=='tactical';state.graph.scene().add(jumpSphere);}
    }
    if(state.layoutMode==='tactical'&&state.graph)setLayoutMode('tactical',state.tacticalCentre,{reframe:false});
    markOverlayDirty('jump-route');
  };
  function drawJumpRoute(context,camera,width,height,phase) {
    const data=state.jumpRouteState;if(!data)return;
    const view=state.layoutMode==='tactical'?window.EveJumpOverlay.tacticalView(data,state.nodesById):physicalJumpView;
    if(!view)return;
    const point=id=>{const node=view.points.get(Number(id));return node?projectVisible(node,camera,width,height):null;};
    context.save();context.shadowBlur=0;
    if(phase==='links') {
      window.EveMapStyles.applyLine(context,'PLANNED_JUMP');
      for(const leg of data.route.legs) {
        const source=view.points.get(Number(leg.source_id)),target=view.points.get(Number(leg.target_id));
        const clipped=source&&target?projectGateSegment(source,target,camera,width,height):null;
        if(clipped){context.beginPath();context.moveTo(clipped.a.x,clipped.a.y);context.lineTo(clipped.b.x,clipped.b.y);context.stroke();}
      }
    } else {
      const draw=(id,kind,offset=10)=>{
        const p=point(id);if(!p)return;
        const style=window.EveMapStyles.registry[kind];context.globalAlpha=1;context.fillStyle=style.color;
        const node=state.nodesById.get(Number(id));
        const radius=effectiveTacticalRadius(node);
        if(radius && kind==='JUMP_RANGE') {
          drawTacticalSystemRing(context,node,style.color);
        } else {
          context.font=`600 ${radius?radius*2.2:13}px system-ui`;context.textAlign='center';context.textBaseline='middle';
          const gap=radius&&offset?radius*2:offset;
          context.fillText(style.symbol,p.x+gap,p.y-gap);
        }
      };
      for(const id of data.reachableSystemIds||[]) {
        if(state.layoutMode==='tactical'&&!Object.prototype.hasOwnProperty.call(state.nodesById.get(Number(id))||{},'inNeighborhood'))continue;
        draw(id,'JUMP_RANGE',0);
      }
      for(const midpoint of data.midpoints||[])draw(midpoint.system_id,'MIDPOINT');
      for(const cyno of data.cynos||[]) {
        // A returned snapshot is never an indefinitely live position.
        if(!cyno.position_fresh||Date.now()/1000-cyno.observed_at>30)continue;
        const p=point(cyno.system_id);if(!p)continue;
        window.EveMapStyles.applyLine(context,'CYNO_CONNECTION');
        context.beginPath();context.moveTo(p.x,p.y);context.lineTo(p.x+18,p.y-18);context.stroke();
        draw(cyno.system_id,'CYNO_POSITIONED',18);
      }
    }
    context.restore();
  }
  window.setEveMapTacticalOverlays = payload => {
    // Caller supplies computed IDs only. Never merge these legs into gates/BFS.
    for (const key of Object.keys(tacticalOverlays)) tacticalOverlays[key] = Array.isArray(payload?.[key]) ? payload[key].filter(value => value != null).map(value => typeof value === 'object' ? {...value} : value) : [];
    markOverlayDirty('tactical-overlays');
  };
  function drawTacticalOverlays(context,camera,width,height,phase) {
    if (state.layoutMode !== 'tactical' || !state.tactical2D) return;
    const styles=window.EveMapTactical.OVERLAY_STYLES;
    const pointFor = id => {
      const node=state.nodesById.get(Number(id));
      // Only members of this layout have hop metadata; no Physical fallback.
      return node && Object.prototype.hasOwnProperty.call(node,'inNeighborhood') && visibleNode(node) ? projectVisible(node,camera,width,height) : null;
    };
    context.save(); context.globalAlpha=1; context.shadowBlur=0; context.lineWidth=1.5;
    if (phase === 'links') {
      window.EveMapStyles.applyLine(context,'PLANNED_JUMP');
      for (const leg of tacticalOverlays.plannedJumpLegs) {
        const a=pointFor(leg.sourceSystemId),b=pointFor(leg.targetSystemId);
        if(a && b) { context.beginPath();context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);context.stroke(); }
      }
    } else {
      context.font='600 13px system-ui';context.textAlign='center';context.textBaseline='middle';
      const draw = (id,kind) => {
        if(kind==='JUMP_RANGE') {drawTacticalSystemRing(context,state.nodesById.get(Number(id)),styles[kind].color);return;}
        const point=pointFor(id);if(!point)return;context.fillStyle=styles[kind].color;context.fillText(styles[kind].symbol,point.x+9,point.y+9);
      };
      tacticalOverlays.reachableSystemIds.forEach(id=>draw(id,'JUMP_RANGE'));
      tacticalOverlays.cynos.forEach(row=>draw(row.systemId,row.kind==='CYNO_ALT'?'CYNO_ALT':'CYNO'));
      tacticalOverlays.midpoints.forEach(row=>draw(row.systemId,'MIDPOINT'));
      tacticalOverlays.unreachableSystemIds.forEach(id=>draw(id,'UNREACHABLE'));
    }
    context.restore();
  }
  function setFlatCameraControls(controls, flat) {
    if (!controls) return;
    controls.enableRotate = !flat;
    // Preserve the existing pan/zoom bindings and node click handling.
  }
  function stabilizeOrbitControls(controls) {
    if (!controls) return;
    controls.minPolarAngle = NEW_EDEN_MIN_POLAR_ANGLE;
    controls.maxPolarAngle = NEW_EDEN_MAX_POLAR_ANGLE;
    // Pan on the camera's visible axes. World-plane panning turns a vertical
    // drag into apparent forward/backward travel as soon as the map is tilted.
    controls.screenSpacePanning = true;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    // Restore the former camera feel: left-click orbit eases into place rather
    // than stopping abruptly.  Pan and dolly keep their direct, predictable axes.
    controls.enableDamping = true;
    controls.dampingFactor = .075;
    // ForceGraph's bundled Three controls use the standard numeric mouse map.
    // Declare it explicitly: left rotates, middle/wheel only dollies, right
    // pans in the camera screen plane.  This used to be silently ignored while
    // ForceGraph selected TrackballControls by default.
    if (controls.mouseButtons) Object.assign(controls.mouseButtons, { LEFT: 0, MIDDLE: 1, RIGHT: 2 });
    controls.object?.up?.set?.(0, 1, 0);
  }
  // A/B scheduler: ForceGraph stays active for the entire visible-map
  // lifecycle. Do not add idle pause/refresh logic here while this test runs.
  function resumeGraphAnimation() {
    if (!state.visible || !state.graph || document.visibilityState === 'hidden') return;
    state.graph.resumeAnimation?.();
  }
  function stopGraphAnimation() {
    state.graph?.pauseAnimation?.();
  }
  function handleMapVisibilityChange(isVisible = document.visibilityState !== 'hidden') {
    if (!state.visible || !state.graph) return false;
    if (!isVisible) {
      stopGraphAnimation(); stopGateOverlay(); stopSkyFrame();
      return false;
    }
    // WebView2 may have delivered a zero/stale viewport while backgrounded.
    // Revalidate both ForceGraph's renderer and the camera before projecting
    // the canvas overlay again.
    state.resizeMap?.();
    const camera = state.graph.camera?.();
    camera?.updateProjectionMatrix?.();
    camera?.updateMatrixWorld?.(true);
    resumeGraphAnimation();
    markOverlayDirty('visibility-resume');
    startSkyFrame();
    return true;
  }
  function animateCameraFor(durationMs) {
    state.cameraAnimating = true;
    markOverlayDirty('camera-tween');
    if (state.cameraIdleTimer) clearTimeout(state.cameraIdleTimer);
    state.cameraIdleTimer = setTimeout(() => {
      state.cameraIdleTimer = null;
      state.cameraAnimating = false;
      markOverlayDirty('camera-settled');
    }, Math.max(0, Number(durationMs) || 0) + 80);
  }
  function bindSkyQualityControls(controls) {
    if (!controls?.addEventListener) return;
    const settleCamera = () => { if (state.cameraIdleTimer) clearTimeout(state.cameraIdleTimer); state.cameraIdleTimer = setTimeout(() => { state.cameraAnimating = false; }, 140); };
    controls.addEventListener('start', () => { state.skyInteracting = true; state.cameraAnimating = true; markOverlayDirty('camera'); });
    controls.addEventListener('change', () => { state.cameraAnimating = true; markOverlayDirty('camera'); settleCamera(); });
    controls.addEventListener('end', () => {
      state.skyInteracting = false;
      // The next pass redraws the same view at the settled quality rather than
      // leaving the lower-cost interaction frame on screen.
      state.skyFrameKey = null;
      state.skyLastPaintAt = 0;
      markOverlayDirty('camera'); settleCamera();
    });
  }
  const ageText = seconds => seconds == null ? 'unavailable' : seconds < 60 ? 'just now' : `${Math.max(1, Math.round(seconds / 60))} min`;
  function refreshMapHeader() {
    const hotspotButton = document.getElementById('eve-map-hotspots');
    if (hotspotButton) { hotspotButton.setAttribute('aria-pressed', String(state.showCombatHotspots)); hotspotButton.classList?.[state.showCombatHotspots ? 'add' : 'remove']('is-active'); }
    document.querySelectorAll?.('.eve-map-chip input').forEach(input => input.closest?.('.eve-map-chip')?.classList?.[input.checked ? 'add' : 'remove']('is-active'));
  }
  // Traffic is principally a link-level signal.  Nodes retain only a small
  // logarithmic lift so busy hubs remain discoverable without turning the map
  // into a layer of glowing blobs.
  const trafficStrength = jumps => Math.max(0, Math.min(1, Math.log1p(Math.max(0, Number(jumps) || 0)) / Math.log(50000)));
  const trafficSize = jumps => 1 + trafficStrength(jumps) * .10;
  const trafficNodeStyle = jumps => {
    const intensity = trafficStrength(jumps);
    return { radius: 1.35 + intensity * 2.15, alpha: .045 + intensity * .085 };
  };
  const nodeSize = node => (security(node.security) === 'high' ? 1.1 : 1) * (state.filters.traffic ? trafficSize(liveFor(node).ship_jumps) : 1);
  function buildGateDegrees(gates) {
    const degrees = new Map();
    gates.forEach(gate => { degrees.set(gate.source, (degrees.get(gate.source) || 0) + 1); degrees.set(gate.target, (degrees.get(gate.target) || 0) + 1); });
    return degrees;
  }
  function rebuildGateFlows() {
    if (!window.EveGateTraffic || !state.data) return state.gateFlows = null;
    const topology = {};
    state.data.gates.forEach(gate => { (topology[gate.source] ||= []).push(gate.target); (topology[gate.target] ||= []).push(gate.source); });
    state.gateFlows = window.EveGateTraffic.estimateGateTraffic(topology, Object.fromEntries(state.trafficBySystem));
  }
  function estimateSystemGateFlow(system, degrees, jumpsBySystem) {
    const jumps = Number(jumpsBySystem.get(system.id) ?? jumpsBySystem.get(String(system.id)) ?? 0);
    return Math.round(Math.max(0, jumps) / Math.max(1, degrees.get(system.id) || 1));
  }
  function estimateGateFlows(source, target, degrees, jumpsBySystem) {
    const cached = state.gateFlows?.gates?.[gateKey(source.id, target.id)];
    if (cached) return { sourceEndpoint: cached.source === String(source.id) ? cached.source_to_target : cached.target_to_source, targetEndpoint: cached.source === String(source.id) ? cached.target_to_source : cached.source_to_target, confidence: cached.confidence, method: cached.method };
    // ESI exposes aggregate jumps per solar system, not a count per stargate.
    // These are endpoint shares, not directions: ESI cannot reveal which gate
    // a ship used or where it came from.
    return {
      sourceEndpoint: estimateSystemGateFlow(source, degrees, jumpsBySystem),
      targetEndpoint: estimateSystemGateFlow(target, degrees, jumpsBySystem),
    };
  }
  function estimateGateTraffic(source, target, degrees, jumpsBySystem) {
    const flows = estimateGateFlows(source, target, degrees, jumpsBySystem);
    return Math.round((flows.sourceEndpoint + flows.targetEndpoint) / 2);
  }
  function trafficParticlePlan(estimatedJumps, particleBudget = currentGraphicsProfile().trafficParticleBudget) {
    const value = Math.max(0, Number(estimatedJumps) || 0);
    if (value < 1) return { count: 0, particles: [] };
    // Each particle is a capacity tier, not another copy of the same flow:
    // 1–100, 101–1000, and 1001–9999. Completed tiers stay red while the
    // active tier evolves from green to red.
    const tierColor = (minimum, maximum) => {
      const t = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
      return `hsl(${Math.round(142 - 130 * t)} 84% 66%)`;
    };
    const particles = [{ tier: 1, color: tierColor(1, 100), opacity: .70 }];
    if (value > 100) particles.push({ tier: 2, color: tierColor(101, 1000), opacity: .80 });
    if (value > 1000) particles.push({ tier: 3, color: tierColor(1001, 9999), opacity: .88 });
    const budget = Math.max(1, Math.floor(Number(particleBudget) || 1));
    // Low retains the same flow magnitude but collapses visual tiers to one
    // representative particle, avoiding a misleadingly quiet high-flow gate.
    const planned = particles.length <= budget ? particles : [particles[particles.length - 1]];
    return { count: planned.length, particles: planned, jumps: value };
  }
  const trafficPacketOffsets = count => Array.from({ length: count }, (_, index) => index * .052);
  const trafficParticleSpeed = jumps => 5 + 18 * Math.pow(Math.max(0, Math.min(1, Math.log10(Math.max(1, jumps)) / 4)), .78);
  const trafficTransitSeconds = (jumps, worldLength) => Math.max(.7, Math.min(6, Math.max(1, worldLength) / trafficParticleSpeed(jumps)));
  const trafficParticleProgress = (now, phase, jumps, worldLength) => {
    // The travel period is derived from stable map-space coordinates, never
    // from the projected canvas length: moving the camera must not alter time.
    const transitSeconds = trafficTransitSeconds(jumps, worldLength);
    return (now / 1000 / transitSeconds + phase) % 1;
  };
  const trafficSegmentWorldLength = segment => {
    const source = segment?.source, target = segment?.target;
    if (!source || !target) return 1;
    return Math.hypot(Number(target.x) - Number(source.x), Number(target.y) - Number(source.y), Number(target.z) - Number(source.z));
  };
  const trafficSegmentProgress = (now, phase, jumps, segment) => {
    const explicitLength = Number(segment?.worldLength);
    return trafficParticleProgress(now, phase, jumps, explicitLength > 0 ? explicitLength : trafficSegmentWorldLength(segment));
  };
  const trafficParticleVisualStyle = (particle, profile = currentGraphicsProfile()) => ({
    glowRadius: 3.6 * profile.trafficGlow,
    glowAlpha: .22 * Number(particle?.opacity || 0) * profile.trafficGlow,
    coreRadius: 1.36 * Math.max(.72, profile.trafficGlow),
    coreAlpha: Math.min(1, .42 + Number(particle?.opacity || 0) * .72),
  });
  // Systems may gain a little screen presence at galaxy scale, but never enough
  // to compete with the explicitly selected character marker.
  const systemObjectScale = distance => Math.max(.72, Math.min(1.08, .72 + Math.log1p(Math.max(distance, 1) / 180) / 17));
  const characterMarkerScale = distance => Math.max(1, Math.min(3.5, .88 + Math.pow(Math.max(distance, 1) / 120, .5)));
  const MAX_SYSTEM_RADIUS_PX = 7;
  // Keep close-range system sizing intact.  This only restores a small amount
  // of screen-space presence once the camera has crossed into region scale.
  const regionalViewPresence = distance => {
    const t = Math.max(0, Math.min(1, (Math.max(0, distance) - 800) / 1600));
    return t * t * (3 - 2 * t);
  };
  const systemScreenRadius = distance => {
    // Local systems should be easy to read around the camera; remote systems
    // must rapidly relinquish visual weight.  This is intentionally based on
    // camera distance, not only global zoom, so foreground and background can
    // coexist without becoming one flat cotton-ball layer.
    return .13 + 4 * Math.exp(-Math.max(0, distance) / 520) + .42 * regionalViewPresence(distance);
  };
  const influenceOverlayOpacity = distance => .50 + .40 * Math.exp(-Math.max(0, distance) / 1500);
  const influenceOverlayStyle = (distance, kind) => {
    const far = Math.max(0, Math.min(1, (distance - 300) / 2200));
    if (kind === 'empire') {
      // Static NPC/faction space is a real filter, not a secondary hint: its
      // disc clears the largest rendered system node even at close range.
      return { radius: MAX_SYSTEM_RADIUS_PX + 1.5 + far * 3.0, opacity: influenceOverlayOpacity(distance) };
    }
    // Player Sov retains a slightly larger territorial mass, but both filters
    // share their opacity so one does not disappear when switching overlays.
    return { radius: MAX_SYSTEM_RADIUS_PX + 2.7 + far * 3.8, opacity: influenceOverlayOpacity(distance) };
  };
  const influenceOverlayRadius = (distance, kind) => influenceOverlayStyle(distance, kind).radius;
  function cappedSystemObjectScale(object, distance, camera, viewportHeight) {
    const desired = systemObjectScale(distance);
    const geometry = object.geometry || object.children?.find(child => child.geometry)?.geometry;
    const worldRadius = geometry?.boundingSphere?.radius || geometry?.parameters?.radius || 1;
    const pixelsPerWorld = viewportHeight * Math.abs(camera.projectionMatrix?.elements?.[5] || 1) / (2 * Math.max(distance, .001));
    const preferredRadius = worldRadius * desired * pixelsPerWorld;
    const targetRadius = Math.max(systemScreenRadius(distance), Math.min(MAX_SYSTEM_RADIUS_PX, preferredRadius));
    return targetRadius / Math.max(.000001, worldRadius * pixelsPerWorld);
  }
  const NODE_LOD = Object.freeze({ close: 350, far: 1050, hysteresis: .12, pointRadius: 1.10 });
  const nodeView = { key: null, rows: [], points: [], centers: new Map(), protectedIds: new Set(), nearest: 2000, revision: 0 };
  const simplifiedGeometries = new WeakMap();
  function nodeLod(distance, previous, protectedNode = false) {
    const close = NODE_LOD.close * (previous === 0 ? 1 + NODE_LOD.hysteresis : 1 - NODE_LOD.hysteresis);
    const far = NODE_LOD.far * (previous === 2 ? 1 - NODE_LOD.hysteresis : 1 + NODE_LOD.hysteresis);
    return distance < close ? 0 : distance < far || protectedNode ? 1 : 2;
  }
  function applyNodeGeometry(node, object, lod) {
    if (!object?.geometry) return;
    // Reuse ForceGraph's bundled Three, with no second Three runtime.
    if (!node._lodGeometry || (object.geometry !== node._lodGeometry && object.geometry !== node._lodMedium)) {
      node._lodGeometry = object.geometry;
      node._lodMedium = null;
    }
    if (lod === 1 && !node._lodMedium && node._lodGeometry.type === 'SphereGeometry') {
      let medium = simplifiedGeometries.get(node._lodGeometry);
      if (!medium) {
        medium = new node._lodGeometry.constructor(node._lodGeometry.parameters.radius, 5, 3);
        simplifiedGeometries.set(node._lodGeometry, medium);
      }
      node._lodMedium = medium;
    }
    object.geometry = lod === 1 && node._lodMedium ? node._lodMedium : node._lodGeometry;
  }
  function updateNodeView(camera, width, height, nodes = state.renderNodes) {
    const key = `${nodeView.revision}:${width}:${height}:${Array.from(camera.matrixWorldInverse.elements)}:${Array.from(camera.projectionMatrix.elements)}`;
    if (key === nodeView.key && nodeView.nodes === nodes) return nodeView;
    nodeView.nodes = nodes;
    nodeView.key = key; nodeView.rows = []; nodeView.points = [];
    nodeView.centers.clear();
    nodeView.protectedIds = tacticalSystemIds();
    let nearest = Infinity;
    const counts = [0, 0, 0];
    for (const node of nodes) {
      state.perf.overlayNodeIterations = (state.perf.overlayNodeIterations || 0) + 1;
      const object = node.__threeObj;
      if (!visibleNode(node)) { if (object) object.visible = false; continue; }
      const distance = Math.hypot(camera.position.x - node.x, camera.position.y - node.y, camera.position.z - node.z);
      nearest = Math.min(nearest, distance);
      const point = projectVisible(node, camera, width, height);
      const inView = point && point.x >= -8 && point.x <= width + 8 && point.y >= -8 && point.y <= height + 8;
      if (!inView) { if (object) object.visible = false; continue; }
      const lod = nodeLod(distance, node._nodeLod, nodeView.protectedIds.has(Number(node.id)));
      node._nodeLod = lod; counts[lod] += 1;
      const row = { node, point, distance, lod };
      nodeView.rows.push(row);
      nodeView.centers.set(Number(node.id),point);
      if (state.layoutMode === 'tactical' || lod === 2 || !object) nodeView.points.push(row);
      if (object) {
        object.visible = lod !== 2 && !(state.layoutMode === 'tactical' && state.tactical2D);
        if (lod !== 2) {
          applyNodeGeometry(node, object, lod);
          object.scale?.setScalar(cappedSystemObjectScale(object, distance, camera, height));
          // This also runs from scene.onBeforeRender, after Three's matrix pass.
          object.updateMatrixWorld?.(true);
          state.perf.nodeScaleUpdates = (state.perf.nodeScaleUpdates || 0) + 1;
        }
      }
    }
    nodeView.nearest = Number.isFinite(nearest) ? nearest : 2000;
    Object.assign(state.perf, { visibleNodes: nodeView.rows.length, renderedLOD0: counts[0], renderedLOD1: counts[1], renderedLOD2: counts[2] });
    return nodeView;
  }
  function installRenderMetrics(graph, host) {
    const scene = graph.scene?.();
    if (!scene) return;
    const previous = scene.onBeforeRender;
    let lastFrame = null, windowStart = null, frames = 0;
    scene.onBeforeRender = function (renderer, sceneArg, camera, ...rest) {
      previous?.call(this, renderer, sceneArg, camera, ...rest);
      if (!state.visible || document.visibilityState === 'hidden') return;
      const now = performance.now();
      if (lastFrame !== null && now - lastFrame < 1000) state.perf.frameTimeMs = now - lastFrame;
      lastFrame = now;
      if (windowStart === null || now - windowStart > 2000) { windowStart = now; frames = 0; }
      frames += 1;
      if (now - windowStart >= 1000) {
        state.perf.fps = frames * 1000 / (now - windowStart);
        windowStart = now; frames = 0;
      }
      // Three has already updated the camera matrices here. Apply geometry
      // before its draw calls; the overlay reuses this exact pose/cache.
      updateNodeView(camera, host.clientWidth, host.clientHeight);
    };
    graph.onEngineTick?.(() => {
      state.perf.forceSimulationTicks = (state.perf.forceSimulationTicks || 0) + 1;
      if (state.layoutMode === 'tactical') markOverlayDirty('tactical-tick');
    });
  }
  function tacticalSystemVisualCenter(node) {
    return nodeView.centers.get(Number(node?.id)) || null;
  }
  function tacticalSystemVisualRadius(node) {
    return effectiveTacticalRadius(node);
  }
  function drawTacticalSystemRing(context,node,color) {
    const center=tacticalSystemVisualCenter(node), radius=tacticalSystemVisualRadius(node);
    if(!center||!radius)return;
    context.save();context.strokeStyle=color;context.lineWidth=1;context.shadowBlur=0;
    context.beginPath();context.arc(center.x,center.y,radius*1.2,0,Math.PI*2);context.stroke();context.restore();
  }
  function drawDistantNodes(context) {
    context.save(); context.globalAlpha = .96; context.shadowBlur = 0;
    for (const { node, point } of nodeView.points) {
      const flatStyle = state.layoutMode === 'tactical' && state.tactical2D ? window.EveMapTactical.visualHierarchy(node.hops, tacticalLabelPriority(node)) : null;
      context.globalAlpha = flatStyle?.opacity ?? .96;
      context.fillStyle = focusNodeColor(node);
      const center=flatStyle?tacticalSystemVisualCenter(node):point;
      if(!center)continue;
      context.beginPath(); context.arc(center.x, center.y, flatStyle?tacticalSystemVisualRadius(node):(state.layoutMode === 'tactical' ? 2.5 : NODE_LOD.pointRadius), 0, Math.PI * 2); context.fill();
      if (state.layoutMode === 'tactical') { context.strokeStyle = '#b5d8dd'; context.lineWidth = .65; context.stroke(); }
    }
    context.restore();
  }
  const dangerClass = system => `eve-route-danger--${liveFor(system).danger_band}`;
  const axes = ['x', 'y', 'z'];
  function buildSkyStars(count = 3000) {
    let seed = 0x5eede11;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    return Array.from({ length: count }, () => {
      // The sky is a full directional sphere.  The Milky Way-like band is an
      // accent, not the whole field, so looking above/below New Eden remains rich.
      const longitude = random() * Math.PI * 2, band = random() < .30;
      const latitude = band ? Math.sin(longitude * 2.3 - .7) * .19 + (random() - .5) * .42 : Math.asin(random() * 2 - 1);
      const cosLatitude = Math.cos(latitude);
      return { ...worldSkyDirection({ x: cosLatitude * Math.cos(longitude), y: Math.sin(latitude), z: cosLatitude * Math.sin(longitude) }), band, radius: random() < .025 ? 1.15 + random() * 1.25 : .2 + random() * .65, alpha: band ? .2 + random() * .68 : .1 + random() * .48, tone: random() > .88 ? 'warm' : random() > .72 ? 'blue' : 'white' };
    });
  }
  function buildAdjacency(systems, gates) {
    const systemsById = new Map(systems.map(system => [system.id, system]));
    const adjacency = new Map(systems.map(system => [system.id, new Set()]));
    gates.forEach(gate => { adjacency.get(gate.source)?.add(gate.target); adjacency.get(gate.target)?.add(gate.source); });
    return { systemsById, adjacency };
  }
  function findConnectedComponents(systems, systemsById, adjacency) {
    const components = [], visited = new Set();
    systems.forEach(system => {
      if (visited.has(system.id)) return;
      const component = [], queue = [system.id]; visited.add(system.id);
      while (queue.length) {
        const id = queue.pop(); component.push(systemsById.get(id));
        adjacency.get(id).forEach(next => { if (!visited.has(next)) { visited.add(next); queue.push(next); } });
      }
      components.push(component);
    });
    return components;
  }
  function calculateMainBounds(systems) {
    const bounds = systems.reduce((box, system) => {
      axes.forEach(axis => { box.min[axis] = Math.min(box.min[axis], system.position_m[axis]); box.max[axis] = Math.max(box.max[axis], system.position_m[axis]); });
      return box;
    }, { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } });
    const centre = Object.fromEntries(axes.map(axis => [axis, (bounds.min[axis] + bounds.max[axis]) / 2]));
    const span = Math.max(...axes.map(axis => bounds.max[axis] - bounds.min[axis]));
    return { centre, scale: 2200 / span };
  }
  function layoutMainCluster(main, centre, scale, positions) {
    main.forEach(system => positions.set(system.id, Object.fromEntries(axes.map(axis => [axis, (system.position_m[axis] - centre[axis]) * scale]))));
  }
  function layoutDetachedRegions(systems, mainIds, mainCentre, mainScale, positions) {
    const groups = new Map();
    systems.filter(system => !mainIds.has(system.id)).forEach(system => {
      const key = system.region_id || system.id, group = groups.get(key) || []; group.push(system); groups.set(key, group);
    });
    [...groups.values()].forEach((group, index) => {
      const centre = Object.fromEntries(axes.map(axis => [axis, group.reduce((sum, system) => sum + system.position_m[axis], 0) / group.length]));
      const extent = Math.max(1, ...group.flatMap(system => axes.map(axis => Math.abs(system.position_m[axis] - centre[axis]))));
      const direction = axes.map(axis => centre[axis] - mainCentre[axis]), length = Math.hypot(...direction) || 1, angle = index * 2.3999632297;
      const fallback = [Math.cos(angle), Math.sin(angle), Math.sin(angle * .5)];
      const anchor = Object.fromEntries(axes.map((axis, axisIndex) => [axis, (length > 1 ? direction[axisIndex] / length : fallback[axisIndex]) * 1280]));
      const scale = Math.min(mainScale, 190 / extent);
      group.forEach(system => positions.set(system.id, Object.fromEntries(axes.map(axis => [axis, anchor[axis] + (system.position_m[axis] - centre[axis]) * scale]))));
    });
  }
  function buildRenderNodes(systems, positions) {
    return systems.map(system => Object.assign({}, system, positions.get(system.id), { fx: positions.get(system.id).x, fy: positions.get(system.id).y, fz: positions.get(system.id).z }));
  }
  function displayNodes(systems, gates) {
    const { systemsById, adjacency } = buildAdjacency(systems, gates);
    const components = findConnectedComponents(systems, systemsById, adjacency);
    const main = components.reduce((largest, component) => component.length > largest.length ? component : largest, []);
    const { centre, scale } = calculateMainBounds(main), positions = new Map(), mainIds = new Set(main.map(system => system.id));
    state.physicalTransform={centre,scale};
    layoutMainCluster(main, centre, scale, positions);
    layoutDetachedRegions(systems, mainIds, centre, scale, positions);
    return buildRenderNodes(systems, positions);
  }
  function buildLabelGroups(nodes, idKey, nameKey) {
    const groups = new Map();
    nodes.forEach(node => {
      const id = node[idKey], name = node[nameKey]; if (!name) return;
      const group = groups.get(id) || { id, name, x: 0, y: 0, z: 0, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, count: 0, systemIds: [], securityCounts: { high: 0, low: 0, null: 0 } };
      group.x += node.x; group.y += node.y; group.z += node.z; group.count += 1;
      group.systemIds.push(node.id);
      const kind = spaceClass(node);
      group.securityCounts[kind] = (group.securityCounts[kind] || 0) + 1;
      axes.forEach(axis => { group.min[axis] = Math.min(group.min[axis], node[axis]); group.max[axis] = Math.max(group.max[axis], node[axis]); }); groups.set(id, group);
    });
    return [...groups.values()].map(group => ({ ...group, x: group.x / group.count, y: group.y / group.count, z: group.z / group.count, span: Math.max(...axes.map(axis => group.max[axis] - group.min[axis])) }));
  }
  const visibleLabelGroup = (group, filters = state.filters) => Object.entries(group.securityCounts || {}).some(([kind, count]) => count > 0 && filters[kind]);
  const labelsCanOverlap = mode => mode === 'region';
  const labelFade = (distance, start, end) => Math.max(0, Math.min(1, (distance - start) / (end - start)));
  const INTEL_LABEL_METRICS = {
    traffic: { label: 'Traffic', color: '#59dce9', value: live => Number(live.ship_jumps || 0) },
    npc: { label: 'NPC kills', color: '#b78af1', value: live => Number(live.npc_kills || 0) },
    kills: { label: 'Ship / pod kills', color: '#f2ad64', value: live => Number(live.ship_kills || 0) + Number(live.pod_kills || 0) },
    danger: { label: 'Danger', color: '#ef765f', value: live => Number(live.danger || 0) },
    combat: { label: 'Recent combat', color: '#ffbd69', value: live => Number(live.recent_combat_kills || 0) },
  };
  const intelLabelKey = (mode, id) => `${mode}:${id}`;
  const intelLabelMetricValue = (metric, live) => Math.max(0, INTEL_LABEL_METRICS[metric]?.value(live || {}) || 0);
  const intelLabelQuantile = (sorted, percentile) => {
    if (!sorted.length) return 0;
    const index = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * percentile));
    const lower = Math.floor(index), upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  };
  function buildIntelLabelDistributions(valuesByMode, metric) {
    return Object.fromEntries(['system', 'constellation', 'region'].map(mode => {
      const raw = (valuesByMode?.[mode] || []).map(value => Math.max(0, Number(value) || 0));
      if (metric === 'danger') return [mode, { mode, absolute: true, sample_count: raw.length, percentiles: { p50: 50, p75: 75, p90: 90, p97: 97, p99: 99 }, sorted: [] }];
      const sorted = raw.filter(value => value > 0).map(value => Math.log1p(value)).sort((left, right) => left - right);
      return [mode, { mode, absolute: false, sample_count: raw.length, sorted, percentiles: { p50: intelLabelQuantile(sorted, .50), p75: intelLabelQuantile(sorted, .75), p90: intelLabelQuantile(sorted, .90), p97: intelLabelQuantile(sorted, .97), p99: intelLabelQuantile(sorted, .99) } }];
    }));
  }
  function intelLabelNormalizedIntensity(metric, value, distribution) {
    const raw = Math.max(0, Number(value) || 0);
    if (!raw) return 0;
    if (metric === 'danger' || distribution?.absolute) return Math.max(0, Math.min(1, raw / 100));
    const sorted = distribution?.sorted || [];
    if (sorted.length <= 1) return 1;
    const transformed = Math.log1p(raw);
    let low = 0, high = sorted.length;
    while (low < high) { const middle = (low + high) >> 1; if (sorted[middle] <= transformed) low = middle + 1; else high = middle; }
    return Math.max(0, Math.min(1, (low - 1) / (sorted.length - 1)));
  }
  const WORLD_EVENT_STYLE = { incursion: { label: 'INCURSION', color: '#d36af0', priority: 4 }, campaign: { label: 'CAMPAIGN', color: '#63d6f2', priority: 3 }, fw: { label: 'FW', color: '#f3a450', priority: 2 }, sov: { label: 'SOV', color: '#f06d50', priority: 1 } };
  function worldEventsForSystems(systemIds) {
    if (state.worldEvents.state === 'stale' || state.worldEvents.state === 'unavailable') return [];
    const ids = new Set((systemIds || []).map(Number));
    return (state.worldEvents.events || []).filter(event => ids.has(Number(event.system_id)) && (state.eventFilter === 'all' || event.type === state.eventFilter));
  }
  function worldEventSummary(mode, label) {
    const systemIds = mode === 'system' ? [label.id] : label.systemIds;
    const events = worldEventsForSystems(systemIds);
    if (!events.length) return null;
    const top = events.slice().sort((left, right) => (WORLD_EVENT_STYLE[right.type]?.priority || 0) - (WORLD_EVENT_STYLE[left.type]?.priority || 0))[0];
    return { ...top, count: events.length, style: WORLD_EVENT_STYLE[top.type] || WORLD_EVENT_STYLE.campaign };
  }
  function drawWorldEventLabel(context, mode, label, x, y, textWidth, opacity) {
    const event = worldEventSummary(mode, label); if (!event) return;
    const text = `${event.style.label}${event.count > 1 ? ` · +${event.count - 1}` : ''}`, center = mode === 'system' ? x - textWidth / 2 : x, top = y + (mode === 'system' ? 8 : 14);
    context.save(); context.globalAlpha = opacity * .9; context.strokeStyle = event.style.color; context.lineWidth = 2; context.shadowBlur = 4 * currentGraphicsProfile().decorativeGlow; context.shadowColor = event.style.color;
    context.beginPath(); context.moveTo(center - 14, top); context.lineTo(center + 14, top); context.stroke(); context.shadowBlur = 0;
    context.fillStyle = event.style.color; context.font = '600 8px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'top'; context.fillText(text, center, top + 2); context.restore();
  }
  const intelHeatColor = intensity => {
    const ratio = Math.max(0, Math.min(1, intensity)), stops = [[0, [84, 201, 255]], [.50, [75, 219, 210]], [.75, [188, 219, 86]], [.90, [243, 168, 80]], [.97, [240, 87, 91]]];
    const upper = stops.find(stop => ratio <= stop[0]) || stops[stops.length - 1], lower = stops[Math.max(0, stops.indexOf(upper) - 1)], span = Math.max(.0001, upper[0] - lower[0]), local = (ratio - lower[0]) / span;
    return `rgb(${lower[1].map((channel, index) => Math.round(channel + (upper[1][index] - channel) * local)).join(',')})`;
  };
  function intelLabelTextStyle(mode, label, baseOpacity) {
    if (!INTEL_LABEL_METRICS[state.intelLabelMetric]) return { color: null, opacity: baseOpacity };
    const value = state.intelLabelValues.get(intelLabelKey(mode, label.id)) || 0, intensity = intelLabelNormalizedIntensity(state.intelLabelMetric, value, state.intelLabelDistributions[mode]);
    return { color: value ? intelHeatColor(intensity) : null, opacity: baseOpacity * (value ? 1 : .5) };
  }
  function rebuildIntelLabelValues() {
    const startedAt = performance.now();
    const metric = INTEL_LABEL_METRICS[state.intelLabelMetric], values = new Map(), valuesByMode = { system: [], constellation: [], region: [] };
    if (!metric || !state.nodesById) { state.intelLabelValues = values; state.intelLabelDistributions = {}; return; }
    const record = (mode, label, live) => { const value = intelLabelMetricValue(state.intelLabelMetric, live); values.set(intelLabelKey(mode, label.id), value); valuesByMode[mode].push(value); };
    state.nodesById.forEach(system => record('system', system, liveFor(system)));
    ['constellations', 'regions'].forEach(collection => {
      const mode = collection === 'regions' ? 'region' : 'constellation';
      (state.labelGroups?.[collection] || []).forEach(group => record(mode, group, aggregateLiveIntel((group.systemIds || []).map(systemFor).filter(Boolean))));
    });
    state.intelLabelValues = values;
    // Stable cache: full New Eden datasets only, rebuilt on live-data or metric
    // changes, never from the current viewport or animation frame.
    state.intelLabelDistributions = buildIntelLabelDistributions(valuesByMode, state.intelLabelMetric);
    state.perf.intelLabelRebuilds += 1;
    state.perf.intelLabelRebuildMs += Math.max(0, performance.now() - startedAt);
  }
  function drawIntelLabelBar(context, mode, label, x, y, textWidth, opacity) {
    const value = state.intelLabelValues.get(intelLabelKey(mode, label.id)) || 0, metric = INTEL_LABEL_METRICS[state.intelLabelMetric];
    if (!value || !metric) return;
    const intensity = intelLabelNormalizedIntensity(state.intelLabelMetric, value, state.intelLabelDistributions[mode]), maxWidth = mode === 'system' ? 28 : 36, width = Math.max(4, Math.round(maxWidth * Math.max(.12, intensity)));
    const center = mode === 'system' ? x - textWidth / 2 : x, left = center - width / 2, top = y + (mode === 'system' ? 3 : 8);
    const color = intelHeatColor(intensity);
    context.save(); context.globalAlpha = opacity * (.35 + intensity * .65); context.fillStyle = color;
    if (intensity >= .75) { context.shadowBlur = 5 * currentGraphicsProfile().labelGlow; context.shadowColor = color; }
    context.fillRect(left, top, width, 2); context.restore();
  }
  function isPinnedSystemLabel(node) {
    if (!node) return false;
    if (Number(state.selectedSystemId) === Number(node.id)) return true;
    if (state.hoverCandidate?.kind === 'system' && Number(state.hoverCandidate.target?.id) === Number(node.id)) return true;
    if (state.route?.systems?.some(id => Number(id) === Number(node.id))) return true;
    return false;
  }
  function isImportantSystemLabel(node) {
    if (Number(node?.id) === 30000142) return true; // Jita remains a useful galaxy-scale anchor.
    if ((state.gateDegrees.get(node?.id) || 0) >= 6) return true;
    const live = liveFor(node);
    return Number(live.ship_jumps || 0) >= 5000 || Number(live.danger || 0) >= 75;
  }
  function systemLabelOpacity(node, nearestDistance) {
    if (isPinnedSystemLabel(node)) return 1;
    // Use the stabilized LOD: do not fade local labels out inside its
    // 250–310 hysteresis band with a second, contradictory zoom threshold.
    if (state.labelLod.mode === 'system') return 1;
    const closeOpacity = 1 - labelFade(nearestDistance, 160, 285);
    if (closeOpacity > .01) return closeOpacity;
    const mediumOpacity = labelFade(nearestDistance, 250, 340) * (1 - labelFade(nearestDistance, 390, 500));
    return isImportantSystemLabel(node) ? mediumOpacity * .72 : 0;
  }
  function labelDistanceOpacity(label, camera, nearestDistance) {
    if (isPinnedSystemLabel(label)) return 1;
    const position = camera?.position;
    if (!position || !label) return 1;
    const distance = Math.hypot(Number(position.x) - Number(label.x), Number(position.y) - Number(label.y), Number(position.z) - Number(label.z));
    if (state.labelLod.mode === 'system' && distance <= 120) return 1;
    const near = Math.max(state.labelLod.mode === 'system' ? 40 : 1, Number(nearestDistance) || 1), relative = Math.max(1, distance / near);
    // Keep the local neighbourhood confidently legible. Attenuation begins
    // only after twice the nearest-camera distance and reaches the 10% floor
    // much farther out, rather than dimming the useful constellation context.
    return Math.max(.10, 1 - .90 * Math.min(1, (relative - 2) / 6));
  }
  function stableLabelLod(nearestDistance) {
    const previous = state.labelLod.mode;
    // Constellations are the useful middle scale. Give them a deliberately
    // broad, hysteretic range instead of jumping from system labels to regions.
    const next = previous === 'system' ? (nearestDistance > 310 ? 'constellation' : 'system')
      : previous === 'region' ? (nearestDistance < 930 ? 'constellation' : 'region')
      : nearestDistance < 250 ? 'system' : nearestDistance > 1040 ? 'region' : 'constellation';
    state.labelLod.mode = next;
    ['system', 'constellation', 'region'].forEach(mode => {
      const target = mode === next ? 1 : 0;
      state.labelLod.opacity[mode] = state.labelLod.initialized ? state.labelLod.opacity[mode] + (target - state.labelLod.opacity[mode]) * .14 : target;
    });
    state.labelLod.initialized = true;
    return state.labelLod;
  }
  function mapLabelLayers(nearestDistance) {
    const lod = stableLabelLod(nearestDistance);
    return [
      { mode: 'region', opacity: lod.opacity.region },
      { mode: 'constellation', opacity: lod.opacity.constellation },
      // The individual draw rule retains a sparse set of important systems at
      // middle zoom.  The layer itself stays present for pinned hover/selection
      // labels even when the ordinary system fade has reached zero.
      { mode: 'system', opacity: Math.max(lod.opacity.system, lod.mode === 'constellation' ? .72 : 0) },
    ].filter(layer => layer.opacity > .01);
  }
  function mapLabelPlacement(mode, point, textWidth, width, height) {
    let x = mode === 'system' ? point.x - 7 : point.x;
    let y = mode === 'system' ? point.y - 7 : point.y;
    if (mode === 'region') {
      const padding = 6, halfWidth = textWidth / 2;
      x = Math.max(halfWidth + padding, Math.min(width - halfWidth - padding, x));
      y = Math.max(12, Math.min(height - 12, y));
    }
    return { x, y };
  }
  function tacticalLabelPriority(node) {
    if (Number(node.id) === Number(state.selectedSystemId)) return 5;
    if (state.characters.some(character => Number(character.system_id) === Number(node.id))) return 4;
    if (nodeView.protectedIds.has(Number(node.id)) || Number(liveFor(node).danger) >= 75) return 3;
    return node.hops != null && node.hops <= 2 ? 2 : 0;
  }
  function tacticalAttachedLabel(point,textWidth,width,height,radius=4) {
    const gap=radius+4;
    // Right-aligned text ends beside the disk, or starts beside it at the left
    // viewport edge. No collision displacement and no camera-distance offset.
    const leftEnd=point.x-gap;
    const x=leftEnd-textWidth>=2 ? leftEnd : point.x+gap+textWidth;
    const y=point.y-gap-14>=2 ? point.y-gap : Math.min(height-2,point.y+gap+14);
    return {x,y};
  }
  function drawMapLabelLayer(context, camera, width, height, mode, opacity, nearestDistance) {
    const tacticalLabels = state.layoutMode === 'tactical' && mode === 'system';
    const flatLabels = tacticalLabels && state.tactical2D;
    const protectedLabels = tacticalLabels ? tacticalSystemIds() : null;
    const combatLabels = tacticalLabels && state.showCombatHotspots
      ? new Map(combatMarkerGroups(state.combatMarkers.values()).map(group => [Number(group.system_id), group])) : new Map();
    const policyFor = label => {
      if (!tacticalLabels) return null;
      const important = protectedLabels.has(Number(label.id)) || Number(state.preselectedSystem?.id) === Number(label.id)
        || Number(liveFor(label).danger) >= 75 || ['CYNO', 'CYNO_ALT', 'MIDPOINT'].includes(label.kind);
      return window.EveMapTactical.labelPolicy(label.hops, important);
    };
    const labels = (mode === 'region' ? state.labelGroups?.regions : mode === 'constellation' ? state.labelGroups?.constellations : nodeView.rows.map(row => row.node))?.filter(label => (mode === 'system' ? isAreaMember(label) && systemLabelOpacity(label, nearestDistance) > .01 : visibleLabelGroup(label)));
    if (!labels) return;
    const minSpacing = mode === 'region' ? 92 : mode === 'constellation' ? 64 : 48, drawn = [], now = Date.now();
    context.save(); context.textAlign = mode === 'system' ? 'right' : 'center'; context.textBaseline = mode === 'system' ? 'bottom' : 'middle';
    context.font = mode === 'region' ? '600 11px system-ui, sans-serif' : mode === 'constellation' ? '10px system-ui, sans-serif' : '10px system-ui, sans-serif';
    context.fillStyle = mode === 'region' ? 'rgba(177, 235, 245, .72)' : mode === 'constellation' ? 'rgba(166, 207, 220, .52)' : 'rgba(222, 244, 249, .76)';
    labels.slice().sort((a, b) => flatLabels ? tacticalLabelPriority(b)-tacticalLabelPriority(a) || (a.hops ?? 6)-(b.hops ?? 6) || Number(a.id)-Number(b.id) : tacticalLabels
      ? Number(policyFor(b) === 'always') - Number(policyFor(a) === 'always') || (a.hops ?? 6)-(b.hops ?? 6)
      : (mode === 'system' ? systemLabelOpacity(b, nearestDistance) - systemLabelOpacity(a, nearestDistance) : b.count - a.count)).forEach(label => {
      const policy = policyFor(label);
      if (!flatLabels && policy === 'hidden') return;
      const point = flatLabels ? tacticalSystemVisualCenter(label) : projectVisible(label, camera, width, height); if (!point || point.x < 0 || point.x > width || point.y < 0 || point.y > height) return;
      const key = `${mode}:${label.id}`, overlaps = !flatLabels && (policy === 'space' || !labelsCanOverlap(mode)) && drawn.some(other => Math.hypot(other.x - point.x, other.y - point.y) < minSpacing);
      // Keep a recently displayed label through a tiny projection/collision
      // oscillation instead of toggling it every animation frame.
      if (!flatLabels && policy !== 'always' && overlaps && (now - (state.labelVisibility.get(key) || 0)) > 220) return;
      const hopSuffix = tacticalLabels && !label.inNeighborhood ? (label.hops == null ? ' · injoignable' : ` · ${label.hops}j`) : '';
      const combatGroup = combatLabels.get(Number(label.id));
      const combatSuffix = combatGroup ? ` · ${combatMarkerLabel(combatGroup)}` : '';
      const text = mode === 'system' ? label.name + hopSuffix + combatSuffix : label.name.toUpperCase();
      if (mode === 'system') context.font = state.labelLod.mode === 'system'
        ? (Number(label.id) === Number(state.selectedSystemId) ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif')
        : '10px system-ui, sans-serif';
      if (flatLabels) context.font = tacticalLabelPriority(label) >= 4 ? '600 12px system-ui, sans-serif' : label.hops <= 2 ? '11px system-ui, sans-serif' : '10px system-ui, sans-serif';
      const measure = context.measureText(text).width;
      const labelAnchor = mode === 'system' && Number(label.id) === Number(state.selectedSystemId)
        ? { x: point.x - 10, y: point.y - 10 } : point;
      let { x: labelX, y: labelY } = mapLabelPlacement(mode, labelAnchor, measure, width, height);
      if (flatLabels) {
        const placement=tacticalAttachedLabel(point,measure,width,height,tacticalSystemVisualRadius(label));
        labelX=placement.x;labelY=placement.y;
      }
      const lodOpacity = mode === 'system' ? systemLabelOpacity(label, nearestDistance) : opacity;
      const baseOpacity = policy === 'always' ? 1 : lodOpacity * labelDistanceOpacity(label, camera, nearestDistance), textStyle = intelLabelTextStyle(mode, label, baseOpacity);
      context.globalAlpha = flatLabels ? Math.max(window.EveMapTactical.visualHierarchy(label.hops,tacticalLabelPriority(label)).opacity,textStyle.opacity) : textStyle.opacity;
      if (flatLabels) { context.fillStyle = textStyle.color || '#def4f9'; context.font = tacticalLabelPriority(label) >= 4 ? '600 12px system-ui, sans-serif' : label.hops <= 2 ? '11px system-ui, sans-serif' : '10px system-ui, sans-serif'; }
      else if (textStyle.color) context.fillStyle = textStyle.color;
      if (combatGroup) drawTacticalCombatLabel(context, label.name + hopSuffix, combatGroup, labelX, labelY);
      else context.fillText(text, labelX, labelY);
      if (state.intelLabelMetric === 'events') drawWorldEventLabel(context, mode, label, labelX, labelY, measure, baseOpacity); else drawIntelLabelBar(context, mode, label, labelX, labelY, measure, baseOpacity); context.fillStyle = mode === 'region' ? 'rgba(177, 235, 245, .72)' : mode === 'constellation' ? 'rgba(166, 207, 220, .52)' : 'rgba(222, 244, 249, .76)'; drawn.push(point); state.labelVisibility.set(key, now);
      state.labelHitTargets.push({ kind: mode, target: label, x: mode === 'system' ? labelX - measure / 2 : labelX, y: labelY, width: measure, height: 14 });
    });
    context.restore();
  }
  function drawMapLabels(context, camera, width, height, nearestDistance) {
    state.labelHitTargets = [];
    if (state.layoutMode === 'tactical') {
      state.labelLod.mode = 'system';
      drawMapLabelLayer(context, camera, width, height, 'system', 1, nearestDistance);
      return;
    }
    const layers = mapLabelLayers(nearestDistance);
    layers.forEach(layer => drawMapLabelLayer(context, camera, width, height, layer.mode, layer.opacity, nearestDistance));
    // Hovered/selected systems are never allowed to vanish merely because the
    // current LOD layer is regional or constellation-only.
    if (!layers.some(layer => layer.mode === 'system') && [...(state.nodesById?.values?.() || [])].some(isPinnedSystemLabel)) {
      drawMapLabelLayer(context, camera, width, height, 'system', 1, nearestDistance);
    }
  }
  const gateKey = (source, target) => [source, target].sort((a, b) => a - b).join(':');
  const influenceFor = system => {
    const sov = sovereigntyFor(system);
    if (sov.alliance_id) return { id: sov.alliance_id, kind: 'Alliance' };
    if (sov.corporation_id) return { id: sov.corporation_id, kind: 'Corporation' };
    if (sov.faction_id) return { id: sov.faction_id, kind: 'Faction' };
    return system.faction_id ? { id: system.faction_id, kind: 'Faction' } : null;
  };
  const shipIconUrl = shipTypeId => Number.isSafeInteger(Number(shipTypeId)) && Number(shipTypeId) > 0 ? `https://images.evetech.net/types/${Number(shipTypeId)}/icon?size=64` : null;
  const formatKillDate = value => {
    const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return match ? `${match[1]} · ${match[2]} UTC` : 'Date inconnue';
  };
  const killLocation = (kill, fallbackSystemId) => {
    const system = systemFor(kill.solar_system_id || fallbackSystemId);
    return system ? `${system.name} · ${system.constellation}, ${system.region}` : `System ${kill.solar_system_id || fallbackSystemId || '—'}`;
  };
  const compactNumber = value => Math.round(Number(value) || 0).toLocaleString('en-US');
  const compactKillStats = live => `Traffic ${compactNumber(live.ship_jumps)} jumps/h · Ships ${compactNumber(live.ship_kills)} · Pods ${compactNumber(live.pod_kills)} · NPC ${compactNumber(live.npc_kills)} / 1h · R2Z2 ${compactNumber(live.recent_combat_kills)} / 30 min · Danger ${compactNumber(live.danger)}/100`;
  const aggregateStaticIntel = systems => systems.reduce((total, system) => ({
    planet_count: total.planet_count + Number(system?.planet_count || system?.planets?.length || 0),
    moon_count: total.moon_count + Number(system?.moon_count || 0),
    belt_count: total.belt_count + Number(system?.belt_count || system?.belts?.length || 0),
    npc_station_count: total.npc_station_count + Number(system?.npc_station_count || system?.npc_stations?.length || 0),
  }), { planet_count: 0, moon_count: 0, belt_count: 0, npc_station_count: 0 });
  const planetTypeSummary = system => {
    const types = new Map();
    for (const planet of system?.planets || []) {
      const name = String(planet?.type_name || '').trim();
      if (name) types.set(name, (types.get(name) || 0) + 1);
    }
    return [...types.entries()].map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ');
  };
  const staticSystemHoverMarkup = system => {
    const staticIntel = aggregateStaticIntel([system]), sections = [];
    if (staticIntel.planet_count) sections.push(`<div class="eve-map-hover-block"><strong>PLANETS</strong><span>${compactNumber(staticIntel.planet_count)} planets · ${compactNumber(staticIntel.moon_count)} moons</span>${planetTypeSummary(system) ? `<small>${planetTypeSummary(system)}</small>` : ''}</div>`);
    if (staticIntel.belt_count) sections.push(`<div class="eve-map-hover-block"><strong>MINING</strong><span>${compactNumber(staticIntel.belt_count)} asteroid belts</span></div>`);
    if (staticIntel.npc_station_count) {
      const services = [...new Set((system?.npc_stations || []).flatMap(station => station?.services || []))];
      sections.push(`<div class="eve-map-hover-block"><strong>STATIONS</strong><span>${compactNumber(staticIntel.npc_station_count)} NPC stations</span>${services.length ? `<small>${services.map(escapeHtml).join(' · ')}</small>` : ''}</div>`);
    }
    return sections.join('');
  };
  function worldEventsHoverMarkup(systems) {
    const events = worldEventsForSystems((systems || []).map(system => system.id));
    if (!events.length) return state.worldEvents.state === 'stale' ? '<div class="eve-map-hover-block"><strong>EVENTS</strong><small>STALE · no current event marker</small></div>' : '';
    const rows = events.slice(0, 3).map(event => {
      const style = WORLD_EVENT_STYLE[event.type] || WORLD_EVENT_STYLE.campaign;
      if (event.type === 'incursion') return `<small>${style.label} · ${escapeHtml(event.state || 'unknown')} · boss ${event.has_boss ? 'yes' : 'no'} · ${Number(event.systems_affected || 0)} systems</small>`;
      if (event.type === 'fw') return `<small>${style.label} · ${escapeHtml(event.state || 'active')}${event.progress_target ? ` · ${Number(event.progress || 0)}/${Number(event.progress_target)}` : ''}</small>`;
      return `<small>${style.label} · ${escapeHtml(event.event_type || event.state || 'active')}</small>`;
    }).join('');
    return `<div class="eve-map-hover-block"><strong>EVENTS · ${state.worldEvents.state === 'stale' ? 'STALE' : 'LIVE'}</strong>${rows}</div>`;
  }
  function systemHoverMarkup(system) {
    const live = liveFor(system), pilots = state.characters.filter(character => Number(character.system_id) === Number(system.id));
    return `<b>${escapeHtml(system.name)} <small>${Number(system.security).toFixed(2)}</small></b><hr><div class="eve-map-hover-block"><span>${escapeHtml(system.region)} · ${escapeHtml(system.constellation)}</span><span>${compactKillStats(live)}</span>${pilots.length ? `<small>Tracked pilots: ${pilots.map(pilot => escapeHtml(pilot.name)).join(', ')}</small>` : ''}</div>${worldEventsHoverMarkup([system])}${staticSystemHoverMarkup(system)}`;
  }
  function areaHoverMarkup(target, kind) {
    const systems = selectionSystems({ kind, target }), live = aggregateLiveIntel(systems), staticIntel = aggregateStaticIntel(systems);
    const title = kind === 'region' ? 'Region' : 'Constellation';
    const staticSummary = staticIntel.planet_count || staticIntel.belt_count || staticIntel.npc_station_count ? `<div class="eve-map-hover-block"><strong>STATIC</strong><span>${compactNumber(staticIntel.planet_count)} planets · ${compactNumber(staticIntel.moon_count)} moons</span><span>${compactNumber(staticIntel.belt_count)} belts · ${compactNumber(staticIntel.npc_station_count)} NPC stations</span></div>` : '';
    return `<b>${escapeHtml(target.name)}</b><hr><div class="eve-map-hover-block"><span>${title} · ${systems.length} systems</span><span>${compactKillStats(live)}</span></div>${worldEventsHoverMarkup(systems)}${staticSummary}`;
  }
  function gateHoverData(source, target, degrees = state.gateDegrees, jumpsBySystem = state.trafficBySystem) {
    const flows = estimateGateFlows(source, target, degrees, jumpsBySystem);
    return { source, target, flows, estimated_jumps: estimateGateTraffic(source, target, degrees, jumpsBySystem) };
  }
  function gateHoverMarkup(gate) {
    const source = gate?.source?.id != null ? gate.source : state.nodesById?.get(gate?.source);
    const target = gate?.target?.id != null ? gate.target : state.nodesById?.get(gate?.target);
    if (!source || !target) return 'Stargate data unavailable';
    const data = gateHoverData(source, target);
    const confidence = data.flows.confidence == null ? 'Low' : data.flows.confidence >= .75 ? 'High' : data.flows.confidence >= .45 ? 'Medium' : 'Low';
    return `<b>${escapeHtml(source.name)} ↔ ${escapeHtml(target.name)}</b><span>Estimated gate activity: ≈${compactNumber(data.estimated_jumps)} jumps/h</span><small>Estimated directional flow: ${escapeHtml(source.name)} → ${escapeHtml(target.name)} ≈${compactNumber(data.flows.sourceEndpoint)}/h · ${escapeHtml(target.name)} → ${escapeHtml(source.name)} ≈${compactNumber(data.flows.targetEndpoint)}/h · Confidence: ${confidence}</small>`;
  }
  async function loadInfluenceName(influence, systemId) {
    if (!influence || !api()?.get_eve_map_entity_names) return;
    try {
      const response = await api().get_eve_map_entity_names([influence.id]);
      if (state.selectedSystemId !== systemId) return;
      const name = response.names?.[String(influence.id)]?.name;
      const target = document.querySelector(`.eve-map-influence[data-eve-influence-id="${influence.id}"]`);
      if (name && target) target.textContent = `${influence.kind} · ${name}`;
    } catch (_) { /* The ID remains a safe fallback when public ESI is unavailable. */ }
  }
  const selectionKey = selection => selection ? `${selection.kind}:${selection.target.id}` : '';
  const selectionSystems = selection => {
    if (!selection?.target) return [];
    if (selection.kind === 'system') return [selection.target];
    const idKey = selection.kind === 'region' ? 'region_id' : 'constellation_id';
    return (state.data?.systems || []).filter(system => Number(system[idKey]) === Number(selection.target.id));
  };
  const aggregateLiveIntel = systems => {
    const values = systems.map(liveFor);
    const total = values.reduce((result, live) => ({
      ship_jumps: result.ship_jumps + Number(live.ship_jumps || 0), ship_kills: result.ship_kills + Number(live.ship_kills || 0),
      pod_kills: result.pod_kills + Number(live.pod_kills || 0), npc_kills: result.npc_kills + Number(live.npc_kills || 0),
      recent_combat_kills: result.recent_combat_kills + Number(live.recent_combat_kills || 0), recent_combat_pods: result.recent_combat_pods + Number(live.recent_combat_pods || 0),
      danger: Math.max(result.danger, Number(live.danger || 0)),
    }), { ship_jumps: 0, ship_kills: 0, pod_kills: 0, npc_kills: 0, recent_combat_kills: 0, recent_combat_pods: 0, danger: 0 });
    return { ...total, danger_band: dangerBandForScore(total.danger) };
  };
  const panelSectionMarkup = (key, title, content) => `<section class="eve-map-section ${state.panelSections[key] ? 'is-open' : ''}" data-eve-panel-section="${key}"><button type="button" class="eve-map-section-title" aria-expanded="${state.panelSections[key] ? 'true' : 'false'}" onclick="toggleEveMapPanelSection('${key}')"><span>${title}</span><b aria-hidden="true">${state.panelSections[key] ? '▲' : '▼'}</b></button><div class="eve-map-section-body">${content}</div></section>`;
  const selectionInfoMarkup = selection => {
    const target = selection.target;
    if (selection.kind === 'system') {
      const pilots = state.characters.filter(character => Number(character.system_id) === Number(target.id)).map(character => `<span class="eve-pilot"><i style="background:${characterColor(character)}"></i>${escapeHtml(character.name)}</span>`);
      const influence = influenceFor(target);
      return `<h3>${escapeHtml(target.name)} <small>${Number(target.security).toFixed(1)}</small></h3><dl><dt>Region</dt><dd>${escapeHtml(target.region)}</dd><dt>Constellation</dt><dd>${escapeHtml(target.constellation)}</dd>${influence ? `<dt>Influence</dt><dd class="eve-map-influence" data-eve-influence-id="${influence.id}">${escapeHtml(influence.kind)}</dd>` : ''}${pilots.length ? `<dt>Active pilots</dt><dd>${pilots.join('<br>')}</dd>` : ''}</dl><button class="btn mini" type="button" onclick="setEveMapWaypoint(${Number(target.id)})">Set waypoint</button>`;
    }
    const systems = selectionSystems(selection), region = selection.kind === 'constellation' ? systems[0]?.region : null;
    return `<h3>${escapeHtml(target.name)}</h3><dl><dt>Type</dt><dd>${selection.kind === 'region' ? 'Region' : 'Constellation'}</dd>${region ? `<dt>Region</dt><dd>${escapeHtml(region)}</dd>` : ''}<dt>Systems</dt><dd>${systems.length.toLocaleString('fr-BE')}</dd></dl>`;
  };
  const panelKillLocation = (kill, selection) => {
    const system = systemFor(kill.solar_system_id || kill.system_id);
    if (!system || selection?.kind === 'system') return '';
    return selection.kind === 'constellation' ? system.name : `${system.name} · ${system.constellation}`;
  };
  const recentAreaKills = selection => {
    const ids = new Set(selectionSystems(selection).map(system => Number(system.id)));
    return [...state.combatMarkers.values()].filter(marker => ids.has(Number(marker.system_id))).map(marker => ({
      killmail_id: marker.killmail_id, time: marker.killmail_time, value: marker.value, solar_system_id: marker.system_id,
      ship_type_id: marker.victim_ship_type_id, url: marker.killmail_id ? `https://zkillboard.com/kill/${marker.killmail_id}/` : '#',
    })).sort((left, right) => String(right.time || '').localeCompare(String(left.time || ''))).slice(0, 5);
  };
  const mergeKillRows = (liveKills, historicalKills, limit = 5) => {
    const merged = new Map();
    for (const kill of historicalKills || []) {
      const id = Number(kill?.killmail_id);
      if (Number.isFinite(id) && id > 0) merged.set(id, kill);
    }
    for (const kill of liveKills || []) {
      const id = Number(kill?.killmail_id);
      if (Number.isFinite(id) && id > 0) merged.set(id, { ...(merged.get(id) || {}), ...kill });
    }
    return [...merged.values()].sort((left, right) => String(right.time || '').localeCompare(String(left.time || ''))).slice(0, Math.max(1, Number(limit) || 5));
  };
  const killRowsMarkup = (kills, selection) => kills.map(kill => {
    const icon = shipIconUrl(kill.ship_type_id);
    const image = icon ? `<img class="eve-kill-ship-icon" src="${icon}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const location = panelKillLocation(kill, selection);
    return `<a class="eve-kill" data-killmail-id="${Number(kill.killmail_id) || 0}" data-kill-system-id="${Number(kill.solar_system_id || kill.system_id) || 0}" href="${escapeHtml(kill.url || '#')}" target="_blank" rel="noopener">${image}<span><b>${formatKillDate(kill.time)} · ${Math.round(Number(kill.value || 0) / 1e6)} M ISK</b>${location ? `<small>${escapeHtml(location)}</small>` : ''}</span></a>`;
  }).join('');
  const areaLatestMarkup = selection => {
    const entry = state.areaKillHistory.get(selectionKey(selection)), kills = mergeKillRows(recentAreaKills(selection), entry?.kills || []);
    if (kills.length) return `<h4>LATEST KILLS</h4>${killRowsMarkup(kills, selection)}${entry?.loading ? '<small>Loading zKill history…</small>' : ''}`;
    if (entry?.state === 'unavailable') return '<small>zKill history unavailable for this area.</small>';
    if (entry?.state === 'fresh' || entry?.state === 'live' || entry?.state === 'stale') return '<small>No recent zKill history in this area.</small>';
    return '<small>Loading zKill history…</small>';
  };
  const selectionIntelMarkup = selection => {
    const live = aggregateLiveIntel(selectionSystems(selection)), stale = state.live.state === 'stale';
    const latest = selection.kind === 'system' ? `<div class="eve-map-latest" data-eve-kill-selection="${selectionKey(selection)}"><small>Latest zKill: loading…</small></div>` : `<div class="eve-map-latest" data-eve-kill-selection="${selectionKey(selection)}">${areaLatestMarkup(selection)}</div>`;
    return `<dl><dt>Traffic</dt><dd>${Number(live.ship_jumps).toLocaleString('fr-BE')} jumps</dd><dt>Kills</dt><dd data-eve-live-kills>${liveKillText(live)}</dd><dt>Danger</dt><dd data-eve-live-danger>${liveDangerMarkup(live)}</dd></dl><small class="eve-live-updated">${stale ? 'Live Intel stale · ' : ''}Updated ${ageText(state.live.age_seconds)}</small>${latest}`;
  };
  function renderPanelSelection(selection, { loadDetails = true } = {}) {
    const panel = document.getElementById('eve-map-panel'); if (!panel || !selection?.target) return;
    const jumpSelectionChanged=state.selectedSystemId!==selection.target.id;
    closeKillPopover(); state.panelSelection = selection; state.selectedSystemId = selection.kind === 'system' ? selection.target.id : null;
    if(selection.kind==='system'&&jumpSelectionChanged)window.EveJumpPlanner?.setDestination?.(selection.target);
    const host = panel.querySelector?.('#eve-map-selection') || panel;
    host.innerHTML = `${panelSectionMarkup('info', 'INFOS', selectionInfoMarkup(selection))}${panelSectionMarkup('intel', 'LIVE INTEL', selectionIntelMarkup(selection))}`;
    renderRouteAvoidance();
    if (selection.kind === 'system') { if (loadDetails) loadInfluenceName(influenceFor(selection.target), selection.target.id); loadRecentKills(selection); }
    else { bindKillHover(host); loadRecentAreaKills(selection); }
  }
  function showSystem(system, options = {}) { if (system) renderPanelSelection({ kind: 'system', target: system }, options); }
  const liveCombatText = live => !live.recent_combat_kills ? '' : live.recent_combat_pods === live.recent_combat_kills ? ` · R2Z2 🥚 ${live.recent_combat_pods} / 30 min` : ` · R2Z2 ${live.recent_combat_kills}${live.recent_combat_pods ? superscriptNumber(live.recent_combat_pods) : ''} / 30 min`;
  const liveKillText = live => `Ships ${live.ship_kills} · Pods ${live.pod_kills} · NPC ${live.npc_kills}${liveCombatText(live)}`;
  const liveDangerMarkup = live => `<span class="eve-danger-meter eve-danger-meter--${live.danger_band}"><i style="width:${live.danger}%"></i></span> ${live.danger}/100${live.recent_combat_kills ? ` · combat live${live.recent_combat_pods ? ` (${live.recent_combat_pods} pod${live.recent_combat_pods === 1 ? '' : 's'})` : ''}` : ''}`;
  function refreshSelectedLivePanel() {
    const selection = state.panelSelection; if (!selection) return;
    const panel = document.getElementById('eve-map-panel'), live = aggregateLiveIntel(selectionSystems(selection));
    const kills = panel?.querySelector?.('[data-eve-live-kills]'), danger = panel?.querySelector?.('[data-eve-live-danger]');
    if (kills) kills.textContent = liveKillText(live);
    if (danger) danger.innerHTML = liveDangerMarkup(live);
    if (selection.kind !== 'system') {
      const latest = panel?.querySelector?.(`[data-eve-kill-selection="${selectionKey(selection)}"]`);
      if (latest) latest.innerHTML = areaLatestMarkup(selection);
      if (latest) bindKillHover(latest);
    }
  }
  // CCP's documented SDE region ID range, independent of security status.
  // https://developers.eveonline.com/docs/guides/id-ranges/
  const spaceClass = node => Number(node.region_id) >= 11000000 && Number(node.region_id) < 12000000 ? 'wspace' : security(node.security);
  const visibleNode = node => Boolean(state.filters[spaceClass(node)] || (spaceClass(node) === 'wspace' && nodeView.protectedIds.has(Number(node.id))));
  const isAreaMember = (node, focus = state.areaFocus) => !focus || (focus.kind === 'region' ? node.region_id === focus.area.id : node.constellation_id === focus.area.id);
  const baseNodeColor = node => systemSecurityColor(node);
  const focusNodeColor = (node, focus = state.areaFocus) => isAreaMember(node, focus) ? baseNodeColor(node) : mutedSecurityColor(node.security);
  function render() { if (!state.graph) return; nodeView.protectedIds = tacticalSystemIds(); state.graph.nodeVisibility(visibleNode).nodeColor(focusNodeColor).nodeVal(node => nodeSize(node) * (isAreaMember(node) ? 1.22 : .84)).nodeOpacity(.96).nodeLabel(node => `${node.name} · ${node.security.toFixed(2)}${state.filters.traffic ? ` · ${Number(liveFor(node).ship_jumps).toLocaleString('fr-BE')} jumps` : ''}${state.filters.danger ? ` · Danger ${liveFor(node).danger}/100` : ''}`).linkVisibility(link => state.filters.gates && visibleNode(link.source) && visibleNode(link.target)); markOverlayDirty('render'); }
  function clearSystemSelection() {
    if (!state.panelSelection) return;
    state.selectedSystemId = null; state.panelSelection = null;
    state.lastNodeClick = null; state.areaFocus = null; render();
    const panel = document.getElementById('eve-map-panel');
    closeKillPopover();
    const host = panel?.querySelector?.('#eve-map-selection') || panel;
    if (host) host.innerHTML = '<div class="eve-map-empty">Select a system, constellation or region.</div>';
  }
  async function loadLiveIntel() {
    if (!api()?.get_eve_map_live_intel) return;
    try {
      const response = await api().get_eve_map_live_intel();
      state.live = { systems: response.systems || {}, state: response.state || (response.ok ? 'live' : 'unavailable'), updated_at: response.updated_at || null, age_seconds: response.age_seconds };
      state.trafficBySystem = new Map(Object.entries(state.live.systems).map(([id, values]) => [Number(id), Number(values.ship_jumps) || 0]));
      rebuildGateFlows();
    } catch (_) { state.live = { systems: {}, state: 'unavailable', updated_at: null }; }
    rebuildIntelLabelValues();
    render();
    refreshSelectedLivePanel();
    refreshMapHeader();
  }
  function worldEventsPanelMarkup() {
    const stateText = state.worldEvents.state === 'stale' ? 'STALE' : state.worldEvents.state === 'unavailable' ? 'UNKNOWN' : 'LIVE';
    const events = (state.worldEvents.events || []).filter(event => state.eventFilter === 'all' || event.type === state.eventFilter);
    const controls = [['all', 'All'], ['incursion', 'Incursion'], ['campaign', 'Campaign'], ['fw', 'FW'], ['sov', 'Sov']].map(([value, label]) => `<button class="eve-event-filter ${state.eventFilter === value ? 'is-active' : ''}" data-eve-event-filter="${value}" type="button">${label}</button>`).join('');
    const rows = events.slice(0, 8).map(event => `<li><b class="eve-event--${escapeHtml(event.type)}">${escapeHtml(WORLD_EVENT_STYLE[event.type]?.label || event.type)}</b> · ${escapeHtml(systemFor(event.system_id)?.name || 'New Eden')}<small>${escapeHtml(event.state || 'active')}${event.progress != null ? ` · ${escapeHtml(String(event.progress))}` : ''}${event.end_time ? ` · ends ${escapeHtml(event.end_time)}` : ''}</small></li>`).join('');
    return `<div class="eve-world-events"><div class="eve-event-filters">${controls}</div><small class="eve-events-state">${stateText}</small>${rows ? `<ul>${rows}</ul>` : '<small>No active official ESI events.</small>'}</div>`;
  }
  function renderWorldEventsPanel() { const host = document.getElementById('eve-map-world-events'); if (host) host.innerHTML = worldEventsPanelMarkup(); }
  async function loadWorldEvents() {
    if (!api()?.get_eve_map_world_events) return;
    try { const response = await api().get_eve_map_world_events(); state.worldEvents = { events: response.events || [], state: response.state || (response.ok ? 'live' : 'unavailable'), age_seconds: response.age_seconds }; }
    catch (_) { state.worldEvents = { events: [], state: 'unavailable' }; }
    renderWorldEventsPanel(); render();
  }
  function combatMarkerFingerprint(marker) {
    // Keep this intentionally tied to the payload rendered on the map.  A
    // different kill, location, timestamp or display field is a real update;
    // an identical polling response is not.
    return JSON.stringify(marker);
  }
  function mergeCombatMarkers(existingMarkers, incomingMarkers, now = Date.now()) {
    const markers = new Map();
    for (const [key, marker] of (existingMarkers || new Map()).entries()) {
      if (Number(marker?.expiresAt) > now) markers.set(key, marker);
    }
    for (const marker of incomingMarkers || []) {
      const happenedAt = Number(marker?.happened_at) * 1000;
      if (!Number.isFinite(happenedAt) || now - happenedAt > COMBAT_MARKER_TTL_MS) continue;
      markers.set(`zkb:${marker.killmail_id}`, { ...marker, happenedAt, expiresAt: happenedAt + COMBAT_MARKER_TTL_MS });
    }
    let changed = markers.size !== (existingMarkers?.size || 0);
    if (!changed) for (const [key, marker] of markers.entries()) {
      if (combatMarkerFingerprint(existingMarkers.get(key)) !== combatMarkerFingerprint(marker)) { changed = true; break; }
    }
    return { markers, changed };
  }
  async function loadCombatMarkers() {
    if (!api()?.get_eve_map_combat_markers) return;
    try {
      const response = await api().get_eve_map_combat_markers();
      const now = Date.now();
      state.perf.combatPolls += 1;
      const merged = mergeCombatMarkers(state.combatMarkers, response.markers || [], now);
      state.combatMarkers = merged.markers;
      // R2Z2 polls every ten seconds, but an unchanged response must not rebuild
      // all system/constellation/region aggregates.  That full-world work was a
      // visible periodic hitch even with the Low graphics profile enabled.
      if (merged.changed) {
        state.perf.combatStateChanges += 1;
        if (state.layoutMode === 'tactical') {
          const renderedIds = new Set(state.renderNodes.map(node => Number(node.id)));
          const missingSystem = [...state.combatMarkers.values()].some(marker => marker.expiresAt > now && !renderedIds.has(Number(marker.system_id)));
          if (missingSystem) setLayoutMode('tactical', state.tacticalCentre, { reframe: false });
        }
        rebuildIntelLabelValues(); render(); refreshSelectedLivePanel();
      }
    } catch (_) { /* The static map remains fully usable when R2Z2 is offline. */ }
    refreshMapHeader();
  }
  function startCombatStream() {
    const bridge = api();
    // Keep the renderer independently testable and compatible with an older
    // backend: combat is optional, the topology never is.
    if (!bridge?.get_eve_map_combat_markers || !bridge?.set_eve_map_combat_stream_active) return;
    bridge.set_eve_map_combat_stream_active(true);
    loadCombatMarkers();
    if (state.combatMarkerTimer == null) state.combatMarkerTimer = setInterval(loadCombatMarkers, 10_000);
  }
  function stopCombatStream() {
    if (state.combatMarkerTimer != null) clearInterval(state.combatMarkerTimer);
    state.combatMarkerTimer = null;
    api()?.set_eve_map_combat_stream_active?.(false);
  }
  const intelAlertMarkup = settings => `<div class="eve-intel-alert-settings"><label><input type="checkbox" data-eve-intel-alert="enabled" ${settings.enabled ? 'checked' : ''}> Enable nearby kill alerts</label><label><input type="checkbox" data-eve-intel-alert="sound_enabled" ${settings.sound_enabled ? 'checked' : ''}> Sound</label><label class="eve-intel-alert-radius">Radius <input type="number" data-eve-intel-alert="radius_jumps" min="0" max="20" step="1" value="${Math.max(0, Math.min(20, Number(settings.radius_jumps) || 5))}"> jumps</label><small>Uses tracked ESI positions every 15 seconds.</small></div>`;
  function renderIntelAlertSettings() {
    const host = document.getElementById('eve-map-intel-alert-settings');
    if (host) host.innerHTML = intelAlertMarkup(state.intelAlert);
  }
  async function loadIntelAlertSettings() {
    if (!api()?.get_eve_map_intel_alert_settings) return;
    try {
      const response = await api().get_eve_map_intel_alert_settings();
      if (response?.ok && response.settings) state.intelAlert = { ...state.intelAlert, ...response.settings };
    } catch (_) { /* Intel Alert remains optional when an older bridge is used. */ }
    renderIntelAlertSettings();
    renderMusicControls();
  }
  async function saveIntelAlertSettings(values) {
    state.intelAlert = { ...state.intelAlert, ...values };
    renderIntelAlertSettings();
    if (!api()?.set_eve_map_intel_alert_settings) return false;
    try {
      const response = await api().set_eve_map_intel_alert_settings(state.intelAlert);
      if (response?.ok && response.settings) state.intelAlert = { ...state.intelAlert, ...response.settings };
      renderIntelAlertSettings();
      return Boolean(response?.ok);
    } catch (_) { return false; }
  }
  function showIntelAlertToast(alert) {
    const workspace = mapWorkspace(); if (!workspace || !alert) return;
    let toast = document.getElementById('eve-map-intel-alert-toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'eve-map-intel-alert-toast'; toast.className = 'eve-map-intel-alert-toast'; (document.body || workspace).appendChild(toast); }
    toast.innerHTML = `<b>⚠ INTEL</b> · ${escapeHtml(alert.system_name || 'Unknown system')} · ${Number(alert.distance_jumps) || 0} jumps · nearest: ${escapeHtml(alert.nearest_character_name || 'tracked pilot')}`;
    toast.classList.add('is-visible');
    if (state.intelAlertToastTimer != null) clearTimeout(state.intelAlertToastTimer);
    state.intelAlertToastTimer = setTimeout(() => toast.classList.remove('is-visible'), 7000);
  }
  const musicVolume = () => Math.max(0, Math.min(1, Number(newEdenMusic.userVolume) || 0)) * newEdenMusic.duckMultiplier;
  function applyMusicState(response) {
    if (!response) return false;
    ['available', 'playing', 'visible', 'manually_paused', 'volume', 'duck_multiplier', 'shuffle', 'starting', 'track', 'track_index', 'playlist', 'playlist_count', 'error'].forEach(key => {
      if (Object.prototype.hasOwnProperty.call(response, key)) {
        const target = key === 'manually_paused' ? 'manuallyPaused' : key === 'duck_multiplier' ? 'duckMultiplier' : key === 'volume' ? 'userVolume' : key === 'playlist_count' ? 'playlistCount' : key === 'track_index' ? 'trackIndex' : key;
        newEdenMusic[target] = response[key];
      }
    });
    return Boolean(response.ok || response.available);
  }
  const musicControlsMarkup = () => {
    const unavailable = newEdenMusic.available === false;
    const label = unavailable ? 'Local soundtrack unavailable' : newEdenMusic.error ? newEdenMusic.error : newEdenMusic.track ? `${newEdenMusic.track}${newEdenMusic.playlistCount > 1 ? ` · ${newEdenMusic.playlistCount} tracks` : ''}` : `${Math.round(newEdenMusic.userVolume * 100)}%`;
    const starting = Boolean(newEdenMusic.starting);
    const icon = starting ? '…' : newEdenMusic.playing ? 'Ⅱ' : '▶';
    const playlist = Array.isArray(newEdenMusic.playlist) ? newEdenMusic.playlist : [];
    const playlistItems = playlist.slice(0, 40).map((track, index) => `<li class="${index === newEdenMusic.trackIndex ? 'is-current' : ''}"><button type="button" class="eve-map-playlist-entry" data-eve-music-track="${index}" aria-current="${index === newEdenMusic.trackIndex ? 'true' : 'false'}">${escapeHtml(track)}</button></li>`).join('') || '<li>No local tracks found</li>';
    const overflow = playlist.length > 40 ? `<li>+${playlist.length - 40} more tracks</li>` : '';
    return `<div class="eve-map-music-controls"><div class="eve-map-music-row"><span>♫ Music</span><button class="btn mini" id="eve-map-music-previous" type="button" aria-label="Previous track" title="Previous track" ${unavailable || starting ? 'disabled' : ''}>⏮</button><button class="btn mini" id="eve-map-music-toggle" type="button" aria-label="${starting ? 'Starting music' : newEdenMusic.playing ? 'Pause music' : 'Play music'}" title="${starting ? 'Starting local soundtrack…' : newEdenMusic.playing ? 'Pause music' : 'Play music'}" ${unavailable || starting ? 'disabled' : ''}>${icon}</button><button class="btn mini" id="eve-map-music-next" type="button" aria-label="Next track" title="Next track" ${unavailable || starting ? 'disabled' : ''}>⏭</button><button class="btn mini eve-map-music-shuffle ${newEdenMusic.shuffle ? 'is-active' : ''}" id="eve-map-music-shuffle" type="button" aria-label="Shuffle playlist" aria-pressed="${newEdenMusic.shuffle}" title="Shuffle playlist" ${unavailable ? 'disabled' : ''}>⤨</button><input id="eve-map-music-volume" type="range" min="0" max="1" step="0.01" value="${newEdenMusic.userVolume}" aria-label="New Eden music volume" ${unavailable ? 'disabled' : ''}></div><span class="eve-map-music-track" tabindex="0">${escapeHtml(label)}<span class="eve-map-playlist-tooltip" role="tooltip"><b>Local playlist</b><ol>${playlistItems}${overflow}</ol></span></span></div>`;
  };
  function renderMusicControls() {
    let host = document.getElementById('eve-map-music-controls');
    if (!host) {
      const alert = document.getElementById('eve-map-intel-alert-settings');
      if (!alert?.parentNode) return;
      host = document.createElement('div'); host.id = 'eve-map-music-controls'; alert.parentNode.appendChild(host);
    }
    host.innerHTML = musicControlsMarkup();
    host.querySelector?.('#eve-map-music-previous')?.addEventListener('click', () => callMusicBridge('previous_eve_map_music_track'));
    host.querySelector?.('#eve-map-music-toggle')?.addEventListener('click', () => { toggleNewEdenMusic(); });
    host.querySelector?.('#eve-map-music-next')?.addEventListener('click', () => callMusicBridge('next_eve_map_music_track'));
    host.querySelector?.('#eve-map-music-shuffle')?.addEventListener('click', () => setNewEdenMusicShuffle(!newEdenMusic.shuffle));
    host.querySelector?.('#eve-map-music-volume')?.addEventListener('input', event => setNewEdenMusicVolume(event.target.value));
    host.querySelectorAll?.('[data-eve-music-track]').forEach(button => button.addEventListener('click', () => callMusicBridge('select_eve_map_music_track', Number(button.dataset.eveMusicTrack))));
  }
  async function callMusicBridge(method, value) {
    const bridge = api();
    if (!bridge?.[method]) { newEdenMusic.available = false; renderMusicControls(); return null; }
    try {
      const response = value === undefined ? await bridge[method]() : await bridge[method](value);
      applyMusicState(response); renderMusicControls();
      // The native player begins after a small deliberate delay. Refresh its
      // state once so the temporary ellipsis reliably becomes the pause icon.
      if (response?.starting) setTimeout(() => { callMusicBridge('get_eve_map_music_state'); }, 650);
      return response;
    } catch (_) { newEdenMusic.available = false; renderMusicControls(); return null; }
  }
  async function loadNewEdenMusic() { return callMusicBridge('get_eve_map_music_state'); }
  async function startNewEdenMusic() {
    newEdenMusic.visible = true;
    if (!MUSIC_AUTOSTART_ENABLED) { renderMusicControls(); return false; }
    await loadNewEdenMusic();
    if (newEdenMusic.manuallyPaused) return false;
    const response = await callMusicBridge('set_eve_map_music_visible', true);
    return Boolean(response?.ok);
  }
  function stopNewEdenMusic() {
    newEdenMusic.visible = false;
    callMusicBridge('set_eve_map_music_visible', false);
  }
  async function toggleNewEdenMusic() {
    const response = await callMusicBridge('toggle_eve_map_music');
    return Boolean(response?.playing);
  }
  function setNewEdenMusicVolume(value) {
    newEdenMusic.userVolume = Math.max(0, Math.min(1, Number(value) || 0));
    renderMusicControls();
    callMusicBridge('set_eve_map_music_volume', newEdenMusic.userVolume);
  }
  function setNewEdenMusicShuffle(enabled) {
    newEdenMusic.shuffle = Boolean(enabled);
    renderMusicControls();
    callMusicBridge('set_eve_map_music_shuffle', newEdenMusic.shuffle);
  }
  async function loadSovereignty() {
    const indicator = document.getElementById('eve-map-sovereignty-state');
    if (!api()?.get_eve_map_sovereignty) { if (indicator) indicator.textContent = 'unavailable'; return; }
    if (indicator) indicator.textContent = 'loading…';
    try {
      const response = await api().get_eve_map_sovereignty();
      state.sovereignty = { systems: response.systems || {}, state: response.state || (response.ok ? 'live' : 'unavailable'), updated_at: response.updated_at || null, age_seconds: response.age_seconds };
    } catch (_) { state.sovereignty = { systems: {}, state: 'unavailable', updated_at: null }; }
    if (indicator) {
      const count = Object.keys(state.sovereignty.systems).length;
      indicator.textContent = state.sovereignty.state === 'live' || state.sovereignty.state === 'fresh' ? `${count.toLocaleString('fr-BE')} systems` : state.sovereignty.state === 'stale' ? `stale · ${count.toLocaleString('fr-BE')}` : 'unavailable';
    }
    render();
    if (state.panelSelection?.kind === 'system') renderPanelSelection(state.panelSelection, { loadDetails: false });
  }
  const characterPositionKey = positions => positions.map(character => `${character.character_id}:${character.system_id}`).sort().join('|');
  const characterPositionSystemId = characterId => state.characters.find(character => String(character.character_id) === String(characterId))?.system_id ?? null;
  function syncSelectedCharacterFromShell() {
    state.selectedCharacterId = window.__selChar == null ? null : String(window.__selChar);
    return state.selectedCharacterId;
  }
  async function loadCharacterPositions() {
    if (!api()?.get_eve_map_character_positions) return false;
    const previousKey = characterPositionKey(state.characters), selectedCharacterId = state.selectedCharacterId, previousSelectedSystemId = characterPositionSystemId(selectedCharacterId);
    try { const response = await api().get_eve_map_character_positions(); state.characters = response.positions || []; }
    catch (_) { state.characters = []; }
    if (state.panelSelection?.kind === 'system') renderPanelSelection(state.panelSelection, { loadDetails: false });
    const selectedSystemId = characterPositionSystemId(selectedCharacterId);
    if (selectedCharacterId && previousSelectedSystemId != null && selectedSystemId != null && previousSelectedSystemId !== selectedSystemId) focus(systemFor(selectedSystemId));
    const changed = previousKey !== characterPositionKey(state.characters);
    if (changed) {
      if (state.layoutMode === 'tactical' && state.tactical2D) setLayoutMode('tactical', state.tacticalCentre, {reframe:false});
      render();
    }
    refreshMapHeader();
    return changed;
  }
  function stopCharacterPositionTracking() {
    if (state.characterTrackingTimer != null) clearTimeout(state.characterTrackingTimer);
    state.characterTrackingTimer = null;
  }
  function scheduleCharacterPositionTracking() {
    const interval = characterPositionTrackingInterval(state.visible);
    if (interval == null || state.characterTrackingTimer != null) return;
    state.characterTrackingTimer = setTimeout(async () => {
      state.characterTrackingTimer = null;
      await loadCharacterPositions();
      scheduleCharacterPositionTracking();
    }, interval);
  }
  function startCharacterPositionTracking() {
    stopCharacterPositionTracking();
    scheduleCharacterPositionTracking();
  }
  async function focusCharacterPosition(characterId) {
    if (!state.visible || !state.graph || characterId == null) return false;
    await loadCharacterPositions();
    const character = state.characters.find(row => String(row.character_id) === String(characterId));
    if (!character) return false;
    state.selectedCharacterId = String(character.character_id);
    startCharacterPositionTracking();
    if (state.layoutMode === 'tactical' && state.tactical2D) setLayoutMode('tactical', character.system_id, {reframe:false});
    focus(systemFor(character.system_id));
    return true;
  }
  function clearCharacterSelection() {
    state.selectedCharacterId = null;
  }
  async function loadRecentKills(selection) {
    if (!api()?.get_eve_map_recent_kills) return;
    const system = selection?.target;
    if (selection?.kind !== 'system' || !system) return;
    const key = selectionKey(selection), box = document.querySelector?.(`.eve-map-latest[data-eve-kill-selection="${key}"]`);
    if (!box) return;
    try {
      const response = await api().get_eve_map_recent_kills(system.id);
      if (selectionKey(state.panelSelection) !== key) return;
      const kills = response.kills || [];
      box.innerHTML = kills.length ? `<h4>LATEST KILLS</h4>${killRowsMarkup(kills, selection)}` : '<small>Latest zKill unavailable.</small>';
      bindKillHover(box);
    } catch (_) { box.textContent = 'Latest zKill unavailable.'; }
  }
  async function loadRecentAreaKills(selection) {
    if (!api()?.get_eve_map_recent_area_kills || !selection?.target || !['region', 'constellation'].includes(selection.kind)) return;
    const key = selectionKey(selection), existing = state.areaKillHistory.get(key);
    if (existing?.loading || (existing?.fetchedAt && Date.now() - existing.fetchedAt < 9 * 60 * 1000)) return;
    state.areaKillHistory.set(key, { ...(existing || {}), loading: true });
    refreshSelectedLivePanel();
    try {
      const response = await api().get_eve_map_recent_area_kills(selection.kind, selection.target.id);
      state.areaKillHistory.set(key, { kills: response.kills || [], state: response.state || (response.ok ? 'live' : 'unavailable'), fetchedAt: Date.now(), loading: false });
    } catch (_) {
      state.areaKillHistory.set(key, { kills: existing?.kills || [], state: 'unavailable', fetchedAt: Date.now(), loading: false });
    }
    if (selectionKey(state.panelSelection) === key) refreshSelectedLivePanel();
  }
  function ensureKillPopover() {
    if (state.killPopover) return state.killPopover;
    const popover = document.createElement('div');
    popover.className = 'eve-kill-popover'; popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-live', 'polite');
    popover.addEventListener('pointerenter', () => { if (state.killPopoverHideTimer) clearTimeout(state.killPopoverHideTimer); });
    popover.addEventListener('pointerleave', () => scheduleKillPopoverHide(state.killHoverKey));
    (document.body || mapWorkspace()).appendChild(popover); state.killPopover = popover;
    return popover;
  }
  function positionKillPopover(anchor, content) {
    const popover = ensureKillPopover();
    popover.innerHTML = content; popover.style.display = 'block';
    const rect = anchor.getBoundingClientRect(), width = Math.min(320, Math.max(230, popover.offsetWidth || 280));
    popover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - width - 10))}px`;
    popover.style.top = `${Math.max(8, Math.min(window.innerHeight - 120, rect.top - 4))}px`;
  }
  function closeKillPopover() {
    if (state.killPopoverHideTimer) clearTimeout(state.killPopoverHideTimer);
    state.killPopoverHideTimer = null; state.killHoverKey = null;
    if (state.killPopover) state.killPopover.style.display = 'none';
  }
  function scheduleKillPopoverHide(key) {
    if (!key) return;
    if (state.killPopoverHideTimer) clearTimeout(state.killPopoverHideTimer);
    state.killPopoverHideTimer = setTimeout(() => {
      if (state.killHoverKey !== key) return;
      closeKillPopover();
    }, 180);
  }
  const isKillPopoverInteractionTarget = (target, popover = state.killPopover) => Boolean(popover?.contains?.(target) || target?.closest?.('.eve-kill'));
  const attackerPopoverMarkup = response => {
    const attackers = response.attackers || [];
    if (!attackers.length) return '<h4>ATTAQUANTS</h4><small>Détails indisponibles.</small>';
    const heading = response.total_attackers > attackers.length ? `ATTAQUANTS · ${attackers.length}/${response.total_attackers}` : `ATTAQUANTS · ${attackers.length}`;
    return `<h4>${heading}</h4>${attackers.map(attacker => {
      const icon = shipIconUrl(attacker.ship_type_id);
      const name = escapeHtml(attacker.pilot_name || 'Unknown pilot'), profile = escapeHtml(attacker.zkill_url || (attacker.character_id ? `https://zkillboard.com/character/${Number(attacker.character_id)}/` : ''));
      return `<div class="eve-kill-attacker">${icon ? `<img src="${icon}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span>${profile ? `<a href="${profile}" target="_blank" rel="noopener"><b>${name}</b></a>` : `<b>${name}</b>`}<small>${escapeHtml(attacker.ship_name || 'Unknown ship')}${attacker.final_blow ? ' · final blow' : ''}</small></span><em>${Number(attacker.damage_done || 0).toLocaleString('fr-BE')}</em></div>`;
    }).join('')}`;
  };
  function bindKillHover(box) {
    if (!api()?.get_eve_map_kill_attackers && !api()?.get_eve_map_kill_attackers_intel) return;
    box.querySelectorAll('.eve-kill[data-killmail-id]').forEach(anchor => {
      const killmailId = Number(anchor.dataset.killmailId), systemId = Number(anchor.dataset.killSystemId);
      if (!killmailId || !systemId) return;
      const key = `${systemId}:${killmailId}`;
      anchor.addEventListener('pointerenter', async () => {
        if (state.killPopoverHideTimer) clearTimeout(state.killPopoverHideTimer);
        state.killHoverKey = key;
        positionKillPopover(anchor, '<h4>ATTAQUANTS</h4><small>Chargement…</small>');
        try {
          const response = await (api().get_eve_map_kill_attackers_intel || api().get_eve_map_kill_attackers)(systemId, killmailId);
          if (state.killHoverKey === key) positionKillPopover(anchor, attackerPopoverMarkup(response));
        } catch (_) {
          if (state.killHoverKey === key) positionKillPopover(anchor, '<h4>ATTAQUANTS</h4><small>Détails indisponibles.</small>');
        }
      });
      anchor.addEventListener('pointerleave', () => scheduleKillPopoverHide(key));
    });
  }
  const overlayAnimationRequired = (traffic, cameraAnimating, hasRoute) => Boolean(traffic || cameraAnimating || hasRoute);
  function scheduleOverlay() {
    if (!state.visible || !state.linkCanvas || state.linkFrame) return;
    state.perf.scheduledFrames += 1;
    state.linkFrame = requestAnimationFrame(() => {
      state.linkFrame = null;
      drawGateOverlay();
      if (overlayAnimationRequired(state.filters.traffic, state.cameraAnimating, state.route)) scheduleOverlay();
    });
  }
  function markOverlayDirty(layer = 'overlay') { nodeView.revision += 1; state.overlayDirty.add(layer); scheduleOverlay(); }
  function stopGateOverlay() {
    if (state.linkFrame) cancelAnimationFrame(state.linkFrame);
    if (state.cameraIdleTimer) clearTimeout(state.cameraIdleTimer);
    state.linkFrame = null; state.cameraIdleTimer = null; state.cameraAnimating = false; state.overlayDirty.clear();
  }
  function startSkyMap(host) {
    state.graph?.backgroundColor?.(currentGraphicsProfile().skyTextureUrl ? 'rgba(7, 17, 28, 0)' : '#000000');
    if (!currentGraphicsProfile().skyTextureUrl) return;
    if (state.skyCanvas) return;
    const canvas = document.createElement('canvas'); canvas.className = 'eve-map-sky'; canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'absolute', inset: '0', zIndex: '0', pointerEvents: 'none' });
    host.appendChild(canvas); state.skyCanvas = canvas; state.skyRenderer = createSkyRenderer(canvas); state.skyStars = state.skyRenderer ? [] : buildSkyStars(currentGraphicsProfile().decorativeStars); state.skyFrameKey = null; state.skyLastPaintAt = 0; state.skyInteracting = false;
    if (state.skyRenderer && state.skyTextureImage) uploadSkyTexture(state.skyRenderer, state.skyTextureImage);
    loadSkyTexture(); markOverlayDirty('sky');
  }
  function compileSkyShader(gl, type, source) {
    const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader); return null;
  }
  function createSkyRenderer(canvas) {
    if (!canvas?.getContext) return null;
    let gl;
    try {
      const options = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
      gl = canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    } catch (_) { return null; }
    if (!gl) return null;
    const vertex = compileSkyShader(gl, gl.VERTEX_SHADER, SKY_GPU_VERTEX_SHADER), fragment = compileSkyShader(gl, gl.FRAGMENT_SHADER, SKY_GPU_FRAGMENT_SHADER);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
    const position = gl.getAttribLocation(program, 'aPosition');
    const locations = { cameraRotation: gl.getUniformLocation(program, 'uCameraRotation'), worldToSky: gl.getUniformLocation(program, 'uWorldToSky'), inverseFocal: gl.getUniformLocation(program, 'uInverseFocal'), texture: gl.getUniformLocation(program, 'uSkyTexture'), debugMode: gl.getUniformLocation(program, 'uSkyDebugMode'), decorations: gl.getUniformLocation(program, 'uDecorations') };
    if (position < 0 || Object.values(locations).some(location => location == null)) { gl.deleteProgram(program); return null; }
    const buffer = gl.createBuffer(), texture = gl.createTexture();
    if (!buffer || !texture) { gl.deleteProgram(program); return null; }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([3, 10, 18, 255]));
    gl.useProgram(program); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0); gl.uniform1i(locations.texture, 0); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    const yaw = -SKY_TEXTURE_YAW;
    return { canvas, gl, program, buffer, position, locations, texture, cameraRotation: new Float32Array(9), worldToSky: new Float32Array([Math.cos(yaw), -Math.sin(yaw), Math.sin(yaw), Math.cos(yaw)]) };
  }
  function uploadSkyTexture(renderer, image) {
    if (!renderer || !image) return false;
    try {
      const { gl, texture } = renderer;
      gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      return true;
    } catch (_) { return false; }
  }
  function releaseSkyTexture() {
    const renderer = state.skyRenderer;
    if (renderer?.gl && renderer?.texture) {
      const { gl, texture } = renderer;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([3, 10, 18, 255]));
    }
    state.skyTextureImage = null; state.skyTextureUrl = null; state.skyTextureLoading = false; state.skyTexture = null; state.skyImage = null; state.skyField = null; state.skyRays = null; state.skyFrameKey = null;
  }
  function applyGraphicsQuality(quality) {
    const next = normalizeGraphicsQuality(quality);
    if (next === state.graphicsQuality) return next;
    state.graphicsQuality = next;
    releaseSkyTexture();
    const host = state.graph ? document.getElementById('eve-map-canvas') : null;
    state.graph?.backgroundColor?.(currentGraphicsProfile().skyTextureUrl ? 'rgba(7, 17, 28, 0)' : '#000000');
    if (!currentGraphicsProfile().skyTextureUrl) {
      const renderer = state.skyRenderer;
      if (renderer) {
        renderer.gl.deleteTexture(renderer.texture);
        renderer.gl.deleteBuffer(renderer.buffer);
        renderer.gl.deleteProgram(renderer.program);
      }
      state.skyCanvas?.remove(); state.skyCanvas = null; state.skyRenderer = null;
    } else if (host && state.graph && !state.skyCanvas) startSkyMap(host);
    state.skyStars = state.skyRenderer ? [] : buildSkyStars(currentGraphicsProfile().decorativeStars);
    if (state.skyCanvas) loadSkyTexture();
    markOverlayDirty('graphics-quality');
    return next;
  }
  async function loadGraphicsSettings() {
    if (!api()?.get_eve_map_graphics_settings) return state.graphicsQuality;
    try {
      const response = await api().get_eve_map_graphics_settings();
      if (response?.ok) applyGraphicsQuality(response.settings?.quality);
    } catch (_) { /* Normal remains the safe default. */ }
    return state.graphicsQuality;
  }
  function cacheSkyTexturePixels(image) {
    const source = document.createElement('canvas'); source.width = image.naturalWidth; source.height = image.naturalHeight;
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('Sky texture canvas is unavailable');
    sourceContext.drawImage(image, 0, 0);
    state.skyTexture = { width: source.width, height: source.height, pixels: sourceContext.getImageData(0, 0, source.width, source.height).data };
  }
  function loadSkyTexture() {
    const url = currentGraphicsProfile().skyTextureUrl;
    if (!url) return;
    if ((state.skyTextureImage && state.skyTextureUrl === url) || state.skyTextureLoading === url || typeof Image !== 'function') return;
    state.skyTextureLoading = url;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Sky texture has no dimensions');
        if (currentGraphicsProfile().skyTextureUrl !== url) return;
        state.skyTextureImage = image; state.skyTextureUrl = url;
        if (!uploadSkyTexture(state.skyRenderer, image)) cacheSkyTexturePixels(image);
      } catch (_) { state.skyTexture = null; }
      state.skyTextureLoading = false; state.skyFrameKey = null; state.skyLastPaintAt = 0; markOverlayDirty('sky-texture');
    };
    image.onerror = () => { if (state.skyTextureLoading === url) state.skyTextureLoading = false; };
    image.src = url;
  }
  function stopSkyFrame() { if (state.skyFrame) cancelAnimationFrame(state.skyFrame); state.skyFrame = null; }
  function startSkyFrame() { markOverlayDirty('sky'); }
  function skyRayDirection(camera, ndcX, ndcY) {
    const world = camera.matrixWorld?.elements, projection = camera.projectionMatrix?.elements;
    if (!world || !projection) return null;
    const viewX = ndcX / Math.max(.001, projection[0]), viewY = ndcY / Math.max(.001, projection[5]), viewZ = -1;
    const length = Math.hypot(viewX, viewY, viewZ) || 1;
    const x = (world[0] * viewX + world[4] * viewY + world[8] * viewZ) / length;
    const y = (world[1] * viewX + world[5] * viewY + world[9] * viewZ) / length;
    const z = (world[2] * viewX + world[6] * viewY + world[10] * viewZ) / length;
    return skyTextureDirection({ x, y, z });
  }
  function skyFieldDimensions(width, height, dpr, moving = state.skyInteracting, profile = currentGraphicsProfile()) {
    const aspect = Math.max(.25, width / Math.max(1, height));
    const floor = moving ? 82000 : 180000, cap = moving ? 145000 : 360000, coverage = moving ? .18 : .34;
    const targetPixels = Math.max(Math.round(floor * profile.skyScale), Math.min(Math.round(cap * profile.skyScale), Math.round(width * height * Math.min(1.25, Math.max(.75, dpr || 1)) * coverage * profile.skyScale)));
    const fieldWidth = Math.max(Math.round((moving ? 300 : 460) * profile.skyScale), Math.round(Math.sqrt(targetPixels * aspect)));
    return { width: fieldWidth, height: Math.max(Math.round((moving ? 170 : 260) * profile.skyScale), Math.round(fieldWidth / aspect)) };
  }
  function buildSkyRayGrid(width, height, projection) {
    const focalX = Math.max(.001, Math.abs(projection?.[0] || 1)), focalY = Math.max(.001, Math.abs(projection?.[5] || 1));
    const key = `${width}:${height}:${Math.round(focalX * 10000)}:${Math.round(focalY * 10000)}`;
    if (state.skyRays?.key === key) return state.skyRays;
    const count = width * height, x = new Float32Array(count), y = new Float32Array(count), z = new Float32Array(count);
    for (let row = 0, index = 0; row < height; row += 1) {
      const viewY = (1 - (row + .5) / height * 2) / focalY;
      for (let column = 0; column < width; column += 1, index += 1) {
        const viewX = ((column + .5) / width * 2 - 1) / focalX, inverseLength = 1 / Math.sqrt(viewX * viewX + viewY * viewY + 1);
        x[index] = viewX * inverseLength; y[index] = viewY * inverseLength; z[index] = -inverseLength;
      }
    }
    state.skyRays = { key, x, y, z };
    return state.skyRays;
  }
  function proceduralNebulaPacked(x, y, z) {
    // This is deliberately low-frequency: the panoramic texture carries the
    // fine detail, while this field only fills gaps and preserves a coherent
    // New Eden-aligned band when the texture cannot be decoded.
    const bend = .11 * Math.sin(x * 4.9 + z * 2.1);
    const plane = Math.abs(y - bend);
    const band = 1 / (1 + plane * plane * 95);
    const broad = .5 + .5 * Math.sin(x * 9.7 + y * 5.6 - z * 7.9);
    const density = band * (.14 + .86 * broad * broad);
    const warm = Math.max(0, Math.sin(x * 3.7 - z * 5.8 + .5)) * density;
    const r = Math.min(255, Math.round(3 + density * 24 + warm * 28)), g = Math.min(255, Math.round(10 + density * 52 + warm * 20)), b = Math.min(255, Math.round(18 + density * 70 + warm * 7));
    return (r << 16) | (g << 8) | b;
  }
  function nebulaColor(x, y, z) {
    const packed = proceduralNebulaPacked(x, y, z);
    return { r: packed >> 16 & 255, g: packed >> 8 & 255, b: packed & 255 };
  }
  function skyTextureCoordinates(x, y, z) {
    return {
      u: .5 + Math.atan2(z, x) / SKY_TAU,
      v: .5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI,
    };
  }
  function skyTexturePacked(texture, x, y, z) {
    if (!texture) return 0;
    // Keep the hot loop allocation-free; skyTextureCoordinates() is retained
    // separately for diagnostics and tests of the spherical mapping.
    const longitude = .5 + Math.atan2(z, x) / SKY_TAU;
    const latitude = .5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI;
    const column = Math.min(texture.width - 1, Math.max(0, Math.floor((longitude - Math.floor(longitude)) * texture.width)));
    const row = Math.min(texture.height - 1, Math.max(0, Math.floor(latitude * texture.height)));
    const index = (row * texture.width + column) * 4, pixels = texture.pixels;
    return (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
  }
  function writeSkyPixel(pixels, index, texture, x, y, z, profile = currentGraphicsProfile()) {
    const procedural = profile.nebulaEnabled ? proceduralNebulaPacked(x, y, z) : 0, textured = skyTexturePacked(texture, x, y, z);
    const proceduralR = procedural >> 16 & 255, proceduralG = procedural >> 8 & 255, proceduralB = procedural & 255;
    if (texture) {
      const textureR = textured >> 16 & 255, textureG = textured >> 8 & 255, textureB = textured & 255;
      pixels[index] = Math.min(255, Math.round(proceduralR * (profile.nebulaEnabled ? .38 : 0) + textureR * .82));
      pixels[index + 1] = Math.min(255, Math.round(proceduralG * (profile.nebulaEnabled ? .38 : 0) + textureG * .82));
      pixels[index + 2] = Math.min(255, Math.round(proceduralB * (profile.nebulaEnabled ? .38 : 0) + textureB * .82));
    } else {
      pixels[index] = proceduralR; pixels[index + 1] = proceduralG; pixels[index + 2] = proceduralB;
    }
    pixels[index + 3] = 255;
  }
  function drawProceduralNebula(context, camera, width, height, dpr) {
    const profile = currentGraphicsProfile(), dimensions = skyFieldDimensions(width, height, dpr, state.skyInteracting, profile), world = camera.matrixWorld?.elements, projection = camera.projectionMatrix?.elements;
    if (!world || !projection) return;
    if (!state.skyField) state.skyField = document.createElement('canvas');
    const field = state.skyField;
    if (field.width !== dimensions.width || field.height !== dimensions.height) { field.width = dimensions.width; field.height = dimensions.height; state.skyImage = null; }
    const fieldContext = field.getContext('2d');
    if (!fieldContext) return;
    if (!state.skyImage) state.skyImage = fieldContext.createImageData(field.width, field.height);
    const pixels = state.skyImage.data, rays = buildSkyRayGrid(field.width, field.height, projection), texture = state.skyTexture;
    const cosine = Math.cos(-SKY_TEXTURE_YAW), sine = Math.sin(-SKY_TEXTURE_YAW);
    for (let point = 0, index = 0; point < rays.x.length; point += 1, index += 4) {
      const viewX = rays.x[point], viewY = rays.y[point], viewZ = rays.z[point];
      const worldX = world[0] * viewX + world[4] * viewY + world[8] * viewZ;
      const worldY = world[1] * viewX + world[5] * viewY + world[9] * viewZ;
      const worldZ = world[2] * viewX + world[6] * viewY + world[10] * viewZ;
      writeSkyPixel(pixels, index, texture, worldX * cosine + worldZ * sine, worldY, -worldX * sine + worldZ * cosine, profile);
    }
    fieldContext.putImageData(state.skyImage, 0, 0);
    context.save(); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; context.drawImage(field, 0, 0, field.width, field.height, 0, 0, width, height); context.restore();
  }
  function skyCameraKey(camera, width, height, dpr) {
    const world = camera.matrixWorld?.elements, projection = camera.projectionMatrix?.elements;
    if (!world || !projection) return null;
    // Translation cannot move an infinitely distant celestial sphere. Quantising
    // rotation avoids repainting it while the graph itself animates beneath it.
    const rotation = [0, 1, 2, 4, 5, 6, 8, 9, 10].map(index => Math.round(world[index] * 700));
    return `${width}:${height}:${dpr}:${Math.round(projection[0] * 700)}:${Math.round(projection[5] * 700)}:${rotation.join(':')}`;
  }
  function skyForward(camera) {
    const world = camera.matrixWorld?.elements;
    if (!world) return null;
    const x = -world[8], y = -world[9], z = -world[10], length = Math.hypot(x, y, z) || 1;
    return { x: x / length, y: y / length, z: z / length };
  }
  function drawSkyGpu(renderer, camera, width, height, dpr, frameKey) {
    const world = camera.matrixWorld?.elements, projection = camera.projectionMatrix?.elements;
    if (!world || !projection) return;
    const { canvas, gl, program, position, locations, texture, cameraRotation, worldToSky } = renderer;
    const profile = currentGraphicsProfile(), qualityScale = (state.skyInteracting ? SKY_GPU_MOVING_SCALE : SKY_GPU_SETTLED_SCALE) * profile.skyScale;
    const pixelWidth = Math.max(1, Math.round(width * dpr * qualityScale)), pixelHeight = Math.max(1, Math.round(height * dpr * qualityScale));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
    cameraRotation[0] = world[0]; cameraRotation[1] = world[1]; cameraRotation[2] = world[2]; cameraRotation[3] = world[4]; cameraRotation[4] = world[5]; cameraRotation[5] = world[6]; cameraRotation[6] = world[8]; cameraRotation[7] = world[9]; cameraRotation[8] = world[10];
    gl.viewport(0, 0, pixelWidth, pixelHeight); gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffer); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    const debugMode = window.__eveMapSkyDebug === 'gas' ? 1 : window.__eveMapSkyDebug === 'stars' ? 2 : 0;
    gl.uniformMatrix3fv(locations.cameraRotation, false, cameraRotation); gl.uniformMatrix2fv(locations.worldToSky, false, worldToSky); gl.uniform2f(locations.inverseFocal, 1 / Math.max(.001, projection[0]), 1 / Math.max(.001, projection[5])); gl.uniform1f(locations.debugMode, debugMode); gl.uniform1f(locations.decorations, profile.nebulaEnabled || profile.nearStarsEnabled ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    state.skyFrameKey = frameKey; state.skyLastPaintAt = performance.now();
  }
  function drawSkyMap(width, height, dpr, camera) {
    if (!currentGraphicsProfile().skyTextureUrl) return;
    const canvas = state.skyCanvas; if (!canvas) return;
    const frameKey = skyCameraKey(camera, width, height, dpr);
    if (frameKey && frameKey === state.skyFrameKey) return;
    if (state.skyRenderer) { drawSkyGpu(state.skyRenderer, camera, width, height, dpr, frameKey); return; }
    const now = performance.now();
    const minimumFrameTime = state.skyInteracting ? SKY_MOVING_FRAME_MS : SKY_SETTLED_FRAME_MS;
    if (state.skyFrameKey && now - state.skyLastPaintAt < minimumFrameTime) return;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) { canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
    const context = canvas.getContext('2d'); context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
    drawProceduralNebula(context, camera, width, height, dpr);
    const forward = skyForward(camera);
    if (!currentGraphicsProfile().nearStarsEnabled) { state.skyFrameKey = frameKey; state.skyLastPaintAt = now; return; }
    state.skyStars.forEach(star => {
      // Cheap hemisphere culling: a perspective camera cannot see stars behind
      // its celestial shell, so they never reach the projection work.
      if (forward && star.x * forward.x + star.y * forward.y + star.z * forward.z <= 0) return;
      const point = projectSkyDirection(star, camera, width, height); if (!point) return;
      const color = star.tone === 'warm' ? '255, 205, 156' : star.tone === 'blue' ? '154, 191, 255' : '232, 238, 255';
      if (star.band) { context.beginPath(); context.arc(point.x, point.y, star.radius * 4.5, 0, Math.PI * 2); context.fillStyle = star.tone === 'warm' ? 'rgba(185, 96, 46, .035)' : 'rgba(65, 101, 158, .025)'; context.fill(); }
      context.beginPath(); context.arc(point.x, point.y, star.radius, 0, Math.PI * 2); context.fillStyle = `rgba(${color}, ${star.alpha})`; context.fill();
    });
    state.skyFrameKey = frameKey; state.skyLastPaintAt = now;
  }
  function projectSkyDirection(direction, camera, width, height) {
    const view = camera.matrixWorldInverse.elements, projection = camera.projectionMatrix.elements;
    const x = view[0] * direction.x + view[4] * direction.y + view[8] * direction.z;
    const y = view[1] * direction.x + view[5] * direction.y + view[9] * direction.z;
    const z = view[2] * direction.x + view[6] * direction.y + view[10] * direction.z;
    const clipX = projection[0] * x + projection[4] * y + projection[8] * z, clipY = projection[1] * x + projection[5] * y + projection[9] * z, clipW = projection[3] * x + projection[7] * y + projection[11] * z;
    if (clipW <= .001) return null;
    const nx = clipX / clipW, ny = clipY / clipW;
    return Math.abs(nx) <= 1.08 && Math.abs(ny) <= 1.08 ? { x: (nx + 1) * width / 2, y: (1 - ny) * height / 2 } : null;
  }
  function cameraViewPoint(point, camera) {
    const view = camera.matrixWorldInverse.elements;
    return {
      x: view[0] * point.x + view[4] * point.y + view[8] * point.z + view[12],
      y: view[1] * point.x + view[5] * point.y + view[9] * point.z + view[13],
      z: view[2] * point.x + view[6] * point.y + view[10] * point.z + view[14]
    };
  }
  function projectViewPoint(point, camera, width, height) {
    const projection = camera.projectionMatrix.elements;
    const clipX = projection[0] * point.x + projection[4] * point.y + projection[8] * point.z + projection[12];
    const clipY = projection[1] * point.x + projection[5] * point.y + projection[9] * point.z + projection[13];
    const clipW = projection[3] * point.x + projection[7] * point.y + projection[11] * point.z + projection[15];
    if (clipW <= .000001) return null;
    return { x: (clipX / clipW + 1) * width / 2, y: (1 - clipY / clipW) * height / 2 };
  }
  function projectGateSegment(source, target, camera, width, height) {
    let a = cameraViewPoint(source, camera), b = cameraViewPoint(target, camera);
    const nearPlane = -Math.max(.001, camera.near || .1);
    if (a.z > nearPlane && b.z > nearPlane) return null;
    if (a.z > nearPlane || b.z > nearPlane) {
      const ratio = (nearPlane - a.z) / (b.z - a.z);
      const intersection = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio, z: nearPlane };
      if (a.z > nearPlane) a = intersection;
      else b = intersection;
    }
    const projectedA = projectViewPoint(a, camera, width, height), projectedB = projectViewPoint(b, camera, width, height);
    return projectedA && projectedB ? clipSegmentToViewport(projectedA, projectedB, width, height) : null;
  }
  function projectVisible(node, camera, width, height) {
    const view = camera.matrixWorldInverse.elements, projection = camera.projectionMatrix.elements;
    const x = view[0] * node.x + view[4] * node.y + view[8] * node.z + view[12];
    const y = view[1] * node.x + view[5] * node.y + view[9] * node.z + view[13];
    const z = view[2] * node.x + view[6] * node.y + view[10] * node.z + view[14];
    const w = projection[3] * x + projection[7] * y + projection[11] * z + projection[15];
    if (w <= 0) return null;
    const nx = (projection[0] * x + projection[4] * y + projection[8] * z + projection[12]) / w;
    const ny = (projection[1] * x + projection[5] * y + projection[9] * z + projection[13]) / w;
    const nz = (projection[2] * x + projection[6] * y + projection[10] * z + projection[14]) / w;
    if (nz < -1 || nz > 1) return null;
    return { x: (nx + 1) * width / 2, y: (1 - ny) * height / 2 };
  }
  function clipSegmentToViewport(a, b, width, height) {
    const dx = b.x - a.x, dy = b.y - a.y, p = [-dx, dx, -dy, dy], q = [a.x, width - a.x, a.y, height - a.y];
    let start = 0, end = 1;
    for (let index = 0; index < 4; index += 1) {
      if (p[index] === 0) { if (q[index] < 0) return null; continue; }
      const ratio = q[index] / p[index];
      if (p[index] < 0) { if (ratio > end) return null; start = Math.max(start, ratio); }
      else { if (ratio < start) return null; end = Math.min(end, ratio); }
    }
    return { a: { x: a.x + dx * start, y: a.y + dy * start }, b: { x: a.x + dx * end, y: a.y + dy * end } };
  }
  function closestPointOnSegment(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
    const progress = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
    return { x: a.x + dx * progress, y: a.y + dy * progress };
  }
  function gateHoverCandidate(targets, x, y, threshold = 5) {
    let candidate = null, bestDistanceSquared = threshold * threshold;
    for (const target of targets || []) {
      const point = closestPointOnSegment({ x, y }, target.a, target.b), distanceSquared = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distanceSquared <= bestDistanceSquared) { bestDistanceSquared = distanceSquared; candidate = { kind: 'gate', ...target, point }; }
    }
    return candidate;
  }
  function enableDistancePicker(host) {
    const label = document.createElement('div'); label.className = 'eve-map-hover'; label.setAttribute('aria-hidden', 'true'); host.appendChild(label);
    let lastPick = 0, showTimer = null, hideTimer = null, pendingKey = '', visibleKey = '';
    const labelCandidateAt = (x, y) => state.labelHitTargets.find(candidate => Math.abs(candidate.x - x) <= candidate.width / 2 + 5 && Math.abs(candidate.y - y) <= candidate.height / 2 + 5);
    const systemCandidateAt = (x, y, rect) => {
      const camera = state.graph?.camera(); if (!camera) return null;
      let nearest = null, bestScore = Infinity;
      updateNodeView(syncOverlayCamera(camera), rect.width, rect.height);
      for (const { node, point, distance } of nodeView.rows) {
        const radius = systemSelectionRadius(distance), score = ((point.x - x) ** 2 + (point.y - y) ** 2) / (radius * radius);
        if (score <= 1 && score < bestScore) { bestScore = score; nearest = { kind: 'system', target: node, point }; }
      }
      return nearest;
    };
    const candidateAtEvent = event => {
      const rect = host.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      return labelCandidateAt(x, y) || systemCandidateAt(x, y, rect) || gateHoverCandidate(state.gateHoverTargets, x, y);
    };
    const hoverKey = candidate => !candidate ? '' : candidate.kind === 'gate' ? `gate:${candidate.key}` : `${candidate.kind}:${candidate.target?.id}`;
    const hoverMarkup = candidate => candidate.kind === 'system' ? systemHoverMarkup(candidate.target) : candidate.kind === 'gate' ? gateHoverMarkup(candidate) : areaHoverMarkup(candidate.target, candidate.kind);
    const placeHover = candidate => {
      const point = candidate.point || candidate;
      label.style.left = `${point.x + 12}px`; label.style.top = `${point.y + 12}px`;
    };
    const showHoverNow = candidate => {
      const key = hoverKey(candidate);
      if (!key) return;
      clearTimeout(showTimer); pendingKey = ''; visibleKey = key; state.hoverCandidate = candidate;
      clearTimeout(hideTimer); label.innerHTML = hoverMarkup(candidate); placeHover(candidate); label.style.display = 'block'; label.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => { if (visibleKey === key) label.classList?.add('is-visible'); });
    };
    const hideVisibleHover = () => {
      if (!visibleKey) return;
      visibleKey = ''; state.hoverCandidate = null;
      label.classList?.remove('is-visible'); label.setAttribute('aria-hidden', 'true');
      clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!visibleKey) label.style.display = 'none'; }, 190);
    };
    const clearHover = () => { setSystemPreselection(null); clearTimeout(showTimer); pendingKey = ''; hideVisibleHover(); host.style.cursor = 'grab'; };
    const scheduleHover = candidate => {
      setSystemPreselection(candidate);
      const key = hoverKey(candidate);
      if (!key) { clearHover(); return; }
      host.style.cursor = 'pointer';
      if (key === visibleKey) { placeHover(candidate); state.hoverCandidate = candidate; return; }
      if (key === pendingKey) return;
      clearTimeout(showTimer); pendingKey = key; hideVisibleHover();
      showTimer = setTimeout(() => {
        if (pendingKey !== key) return;
        showHoverNow(candidate);
      }, MAP_HOVER_DELAY_MS);
    };
    const selectCandidate = candidate => {
      if (!candidate) return;
      // The expanded canvas target is authoritative.  ForceGraph's own hit area
      // is deliberately much smaller, so let this path bypass its short event
      // guard after we have already claimed the click.
      if (candidate.kind === 'system') onNodeClick(candidate.target, { picker: true });
      else if (candidate.kind === 'gate') showHoverNow(candidate);
      else focusArea(candidate.target, candidate.kind);
    };
    host.addEventListener('pointerdown', event => {
      const leftButton = (event.button ?? 0) === 0;
      const candidate = leftButton ? candidateAtEvent(event) : null;
      state.pointer = { x: event.clientX, y: event.clientY, moved: false, button: event.button ?? 0, candidate };
      // ForceGraph receives a background pointer event before its DOM click.
      // Claim an expanded system/label target here so that event cannot clear
      // the selection panel between pointerdown and our click handler.
      if (candidate) state.suppressNodeClickUntil = performance.now() + 700;
    }, true);
    host.addEventListener('pointermove', event => {
      if (state.pointer && Math.hypot(event.clientX - state.pointer.x, event.clientY - state.pointer.y) > 7) state.pointer.moved = true;
      if (event.buttons) { clearHover(); return; }
      const now = performance.now(); if (now - lastPick < 60 || !state.graph) return; lastPick = now;
      const rect = host.getBoundingClientRect(), pointerX = event.clientX - rect.left, pointerY = event.clientY - rect.top, labelCandidate = labelCandidateAt(pointerX, pointerY);
      const candidate = labelCandidate || systemCandidateAt(pointerX, pointerY, rect) || gateHoverCandidate(state.gateHoverTargets, pointerX, pointerY);
      scheduleHover(candidate);
    });
    host.addEventListener('pointerleave', clearHover);
    host.addEventListener('pointerup', () => { if (state.pointer?.moved) state.suppressNodeClickUntil = performance.now() + 180; }, true);
    host.addEventListener('click', event => {
      const pointer = state.pointer;
      if (pointer?.moved) { event.stopImmediatePropagation(); state.pointer = null; return; }
      const candidate = pointer?.candidate || candidateAtEvent(event);
      if (!candidate) { state.pointer = null; return; }
      // ForceGraph can emit its own click after the DOM click when a label sits
      // over a node. Keep the expanded picker authoritative for that brief tail.
      state.suppressNodeClickUntil = performance.now() + 800;
      event.preventDefault(); event.stopImmediatePropagation(); selectCandidate(candidate); state.pointer = null;
    }, true);
    host.addEventListener('contextmenu', event => { const candidate = candidateAtEvent(event); if (!candidate || candidate.kind !== 'system' || state.pointer?.moved) return; state.suppressNodeClickUntil = performance.now() + 280; event.preventDefault(); event.stopImmediatePropagation(); setEndpoint('origin', candidate.target); focus(candidate.target); }, true);
  }
  function combatMarkerGroups(markers, now = Date.now()) {
    const groups = new Map();
    for (const marker of markers) {
      if (!marker?.system_id || now >= marker.expiresAt) continue;
      const group = groups.get(marker.system_id) || { system_id: marker.system_id, count: 0, pod_count: 0, value: 0, latestAt: 0, expiresAt: 0, markers: [] };
      group.count += 1;
      if (isPodMarker(marker)) group.pod_count += 1;
      group.value += Number(marker.value) || 0;
      group.latestAt = Math.max(group.latestAt, marker.happenedAt || 0);
      group.expiresAt = Math.max(group.expiresAt, marker.expiresAt || 0);
      group.markers.push(marker);
      groups.set(marker.system_id, group);
    }
    return [...groups.values()].map(group => ({ ...group, markers: group.markers.sort((a, b) => b.happenedAt - a.happenedAt) }));
  }
  function combatActivity(count) {
    if (count >= 10) return { symbol: '💀', level: 'critical', color: '#ff4867' };
    if (count >= 5) return { symbol: '🔥', level: 'hot', color: '#ff7652' };
    if (count >= 2) return { symbol: '⚠', level: 'warning', color: '#ffb34e' };
    if (count === 1) return { symbol: '◉', level: 'watch', color: '#f4d07f' };
    return { symbol: '●', level: 'quiet', color: '#88a7b2' };
  }
  function combatActivityForDanger(score) {
    if (score >= 100) return { symbol: '💀', level: 'critical', color: '#ff4867' };
    if (score >= 75) return { symbol: '🔥', level: 'hot', color: '#ff7652' };
    if (score >= 50) return { symbol: '⚠', level: 'warning', color: '#ffb34e' };
    if (score >= 20) return { symbol: '◉', level: 'watch', color: '#f4d07f' };
    return { symbol: '●', level: 'quiet', color: '#88a7b2' };
  }
  const combatGroupFor = (systemId, now = Date.now()) => combatMarkerGroups(state.combatMarkers.values(), now).find(group => Number(group.system_id) === Number(systemId)) || { system_id: systemId, count: 0, pod_count: 0, value: 0, markers: [] };
  const combatMarkerLabel = (group, activity = combatActivityForDanger(combatDangerScore(group))) => {
    if (group.pod_count && group.pod_count === group.count) return `🥚 ${group.pod_count}`;
    return `${activity.symbol} ${group.count}${group.pod_count ? superscriptNumber(group.pod_count) : ''}`;
  };
  const combatAge = (happenedAt, now = Date.now()) => `${Math.max(0, Math.floor((now - happenedAt) / 60))}m`;
  function drawTacticalCombatLabel(context, name, group, x, y) {
    const activity = combatActivityForDanger(combatDangerScore(group));
    const suffix = ` · ${combatMarkerLabel(group, activity)}`;
    context.save();
    context.textAlign = 'right';
    context.fillText(name, x-context.measureText(suffix).width, y);
    context.fillStyle = activity.color;
    context.globalAlpha = Math.max(.9, context.globalAlpha);
    context.fillText(suffix, x, y);
    context.restore();
  }
  const combatIsk = value => value >= 1e9 ? `${(value / 1e9).toFixed(2)} B` : value >= 1e6 ? `${Math.round(value / 1e6)} M` : `${Math.round(value / 1e3)} k`;
  function combatHoverMarkup(system, now = Date.now()) {
    const group = combatGroupFor(system.id, now), activity = combatActivityForDanger(combatDangerScore(group));
    const kills = group.markers.slice(0, 5).map(marker => `<span>${combatAge(marker.happenedAt, now)}&nbsp; ${escapeHtml(marker.victim_ship_name || (marker.victim_ship_type_id ? `Ship #${marker.victim_ship_type_id}` : 'Vaisseau inconnu'))}<small>${Number(marker.attacker_count) || 0} attaquant(s)</small></span>`).join('');
    const podText = group.pod_count ? ` · 🥚 ${group.pod_count} pod${group.pod_count === 1 ? '' : 's'}` : '';
    return `<b>${escapeHtml(system.name)} <small>${system.security.toFixed(2)}</small></b><hr><strong style="color:${activity.color}">${combatMarkerLabel(group, activity)} kill${group.count === 1 ? '' : 's'} / 30 min${podText}</strong>${group.count ? `<em>💰 ${combatIsk(group.value)} ISK détruits</em><div class="eve-map-hover-kills">${kills}</div>` : ''}`;
  }
  function drawCombatMarkers(context, camera, width, height, now = Date.now()) {
    for (const [key, marker] of state.combatMarkers) {
      if (!marker?.system_id || now >= marker.expiresAt) state.combatMarkers.delete(key);
    }
    // Hotspots only controls the visible 30-minute annotations.  The R2Z2
    // stream, retained combat data and all danger calculations remain active.
    // Tactical renders name, hops and combat together from the visible node
    // rows. Never project global Physical-only entries into this local view.
    if (state.layoutMode === 'tactical' || !state.showCombatHotspots) { context.globalAlpha = 1; return; }
    for (const group of combatMarkerGroups(state.combatMarkers.values(), now)) {
      const node = state.nodesById.get(Number(group.system_id));
      if (!node || !visibleNode(node)) continue;
      const point = projectVisible(node, camera, width, height);
      if (!point) continue;
      const life = Math.max(0, Math.min(1, (group.expiresAt - now) / COMBAT_MARKER_TTL_MS));
      const activity = combatActivityForDanger(combatDangerScore(group));
      const pulse = .5 + .5 * Math.sin(now / 560 + Number(group.system_id) % 31);
      const underlineWidth = (group.count >= 2 ? 24 : 14) + Math.min(group.count, 4) * 3;
      // Keep the alert clear of the node, character indicators and reticle.
      // The marker remains anchored to its system but reads as a subordinate
      // activity annotation directly beneath it.
      const alertY = point.y + 23;
      const underlineY = alertY + 11;
      context.beginPath(); context.moveTo(point.x - underlineWidth / 2, underlineY); context.lineTo(point.x + underlineWidth / 2, underlineY);
      context.strokeStyle = activity.color; context.globalAlpha = (.38 + pulse * .18) * (.45 + life * .55);
      context.lineWidth = group.count >= 2 ? 2.2 : 1.45; context.stroke();
      if (group.count >= 1) {
        context.font = '700 12px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.fillStyle = activity.color; context.globalAlpha = .72 + pulse * .24; context.fillText(combatMarkerLabel(group, activity), point.x, alertY);
      }
    }
    context.globalAlpha = 1;
  }
  function selectionReticleStyle(distance) {
    const near = Math.max(0, Math.min(1, (Number(distance) || 0) / 1600));
    return { radius: 17 + near * 8, width: 1.25 + near * .55, glow: 7 + near * 5 };
  }
  function setSystemPreselection(candidate) {
    const node = candidate?.kind === 'system' ? candidate.target : null;
    if (state.preselectedSystem?.id === node?.id) return;
    state.preselectedSystem = node;
    markOverlayDirty('reticle');
  }
  function drawReticleBrackets(context, style) {
    const bracket = style.radius * .82, arm = Math.max(5, style.radius * .30);
    [[-bracket, -bracket, 1, 1], [bracket, -bracket, -1, 1], [-bracket, bracket, 1, -1], [bracket, bracket, -1, -1]].forEach(([x, y, sx, sy]) => {
      context.beginPath(); context.moveTo(x, y + sy * arm); context.lineTo(x, y); context.lineTo(x + sx * arm, y); context.stroke();
    });
  }
  function drawSystemPreselection(context, camera, width, height) {
    const node = state.preselectedSystem;
    if (!node || Number(node.id) === Number(state.selectedSystemId) || !visibleNode(node)) return;
    const point = projectVisible(node, camera, width, height);
    if (!point) return;
    const style = selectionReticleStyle(Math.hypot(camera.position.x - node.x, camera.position.y - node.y, camera.position.z - node.z));
    context.save(); context.translate(point.x, point.y);
    context.strokeStyle = '#74f6ff'; context.globalAlpha = .65;
    context.lineWidth = style.width; context.shadowBlur = 0;
    drawReticleBrackets(context, style);
    context.restore();
  }
  function systemSelectionRadius(distance) {
    // The same expanded target is used by hover, click and the 3D reticle.
    // It grows only at distance, so a close constellation remains precise.
    const far = Math.max(0, Math.min(1, ((Number(distance) || 0) - 80) / 1500));
    return 18 + far * 30;
  }
  function effectiveTacticalRadius(node) {
    return node&&state.layoutMode==='tactical'&&state.tactical2D
      ?window.EveMapTactical.visualHierarchy(node.hops,tacticalLabelPriority(node)).radius:null;
  }
  function drawSelectedSystemReticle(context, camera, width, height, now = performance.now()) {
    const selected = state.nodesById?.get(Number(state.selectedSystemId));
    if (!selected || !visibleNode(selected)) return;
    const point = projectVisible(selected, camera, width, height);
    if (!point || point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) return;
    const distance = Math.hypot(camera.position.x - selected.x, camera.position.y - selected.y, camera.position.z - selected.z);
    const style = selectionReticleStyle(distance), pulse = .5 + .5 * Math.sin(now / 360);
    const effectiveRadius=effectiveTacticalRadius(selected);
    if(effectiveRadius) {style.radius=effectiveRadius*2.5;style.width=effectiveRadius*.4;}
    // This lives in the map's rendered overlay and is reprojected from the
    // selected system every frame: it follows the actual 3D node/camera rather
    // than being a static DOM decoration.
    context.save();
    context.translate(point.x, point.y);
    context.strokeStyle = '#74f6ff'; context.shadowColor = '#2ee6e6'; context.shadowBlur = style.glow * currentGraphicsProfile().decorativeGlow;
    context.globalAlpha = .48 + pulse * .28; context.lineWidth = style.width;
    context.beginPath(); context.ellipse(0, 0, style.radius, style.radius * .42, now / 1800, -.28, Math.PI + .28); context.stroke();
    context.globalAlpha = .88; context.lineWidth = style.width + .35;
    context.beginPath(); context.ellipse(0, 0, style.radius, style.radius * .42, now / 1800, Math.PI - .28, SKY_TAU - .28); context.stroke();
    context.globalAlpha = .78;
    drawReticleBrackets(context, style);
    context.restore(); context.globalAlpha = 1;
  }
  function gateVisualProfile(nearestDistance) {
    const proximity = Math.max(0, Math.min(1, (1100 - nearestDistance) / 650));
    const regionView = regionalViewPresence(nearestDistance);
    return {
      localAlpha: .07 + proximity * .11,
      localWidth: .34 + proximity * .18,
      regionalAlpha: .18 + proximity * .18 + regionView * .12,
      regionalWidth: .34 + proximity * .30 + regionView * .18,
      boundaryAlpha: .28 + proximity * .22,
      boundaryWidth: .46 + proximity * .34,
      emphasisWidth: .78 + proximity * .42,
      farTopologyFloor: .16,
      combatAlpha: .46 + proximity * .12,
      combatWidth: .70 + proximity * .28,
      characterAlpha: .78 + proximity * .14,
      characterWidth: .98 + proximity * .48,
    };
  }
  const gateCameraFade = distance => .28 + .72 * (1 - Math.max(0, Math.min(1, (Math.max(0, distance) - 360) / 1900)));
  function tacticalSystemIds(now = Date.now()) {
    const ids = new Set();
    if (state.selectedSystemId != null) ids.add(Number(state.selectedSystemId));
    if (state.hoverCandidate?.kind === 'system') ids.add(Number(state.hoverCandidate.target?.id));
    (state.route?.systems || []).forEach(id => ids.add(Number(id)));
    (state.jumpRouteState?.route?.systems || []).forEach(id=>ids.add(Number(id)));
    state.characters.forEach(character => ids.add(Number(character.system_id)));
    for (const marker of state.combatMarkers.values()) if (marker?.expiresAt > now) ids.add(Number(marker.system_id));
    return ids;
  }
  function gateEmphasisKind(gate, emphasis) {
    const sourceId = Number(gate.source?.id ?? gate.source), targetId = Number(gate.target?.id ?? gate.target), key = gate.key || gateKey(sourceId, targetId);
    if (emphasis.characterSystemIds?.has(sourceId) || emphasis.characterSystemIds?.has(targetId)) return 'character';
    if (emphasis.hoverGateKey === key) return 'hover';
    if (emphasis.combatSystemIds?.has(sourceId) || emphasis.combatSystemIds?.has(targetId)) return 'combat';
    if (emphasis.tacticalSystemIds?.has(sourceId) || emphasis.tacticalSystemIds?.has(targetId)) return 'tactical';
    return null;
  }
  function syncOverlayCamera(camera) {
    // ForceGraph owns camera motion.  Refresh its world/inverse matrices just
    // before Canvas projections so reticles, routes and labels use the same
    // camera pose as the WebGL scene, including the final damping frames.
    camera?.updateMatrixWorld?.(true);
    state.perf.cameraSyncs += 1;
    return camera;
  }
  function drawGateOverlay() {
    if (!state.visible || !state.graph || !state.linkCanvas) return;
    const now = performance.now();
    state.lastLinkDraw = now;
    const canvas = state.linkCanvas, host = document.getElementById('eve-map-canvas'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = host.clientWidth, height = host.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) { canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
    const context = canvas.getContext('2d'); context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
    const camera = syncOverlayCamera(state.graph.camera());
    // One cached pass owns projection, LOD, nearest distance and mesh scaling.
    updateNodeView(camera, width, height);
    drawDistantNodes(context);
    drawSkyMap(width, height, state.skyRenderer ? Math.min(window.devicePixelRatio || 1, SKY_GPU_MAX_DPR, currentGraphicsProfile().skyDpr) : dpr * currentGraphicsProfile().skyDpr, camera); state.perf.skyDraws += 1;
    const nearestSystemDistance = nodeView.nearest;
    if (state.filters.gates) {
      // Resting topology is intentionally quiet.  Route, traffic, hovered
      // systems and combat lift only their own links above this baseline.
      const wallNow = Date.now(), gateStyle = gateVisualProfile(nearestSystemDistance), tacticalIds = tacticalSystemIds(wallNow);
      const gateEmphasis = {
        tacticalSystemIds: tacticalIds,
        characterSystemIds: activeCharacterSystemIds(),
        combatSystemIds: new Set([...state.combatMarkers.values()].filter(marker => marker?.expiresAt > wallNow).map(marker => Number(marker.system_id))),
        hoverGateKey: state.hoverCandidate?.kind === 'gate' ? state.hoverCandidate.key : null,
      };
      const localSegments = [], distantLocalSegments = [], regionalSegments = [], distantRegionalSegments = [], boundarySegments = [], routeSegments = [], focusSegments = [], tacticalSegments = { character: [], hover: [], combat: [], tactical: [] }, trafficSegments = [], gateHoverTargets = [];
      const flatGates = [[], [], [], []];
      const trafficBySystem = state.filters.traffic ? new Map([...state.nodesById.values()].map(node => [node.id, liveFor(node).ship_jumps])) : null;
      (state.activeGates || state.data.gates).forEach(gate => {
        state.perf.overlayGateIterations = (state.perf.overlayGateIterations || 0) + 1;
        state.perf.gateProjections += 1;
        const source = state.nodesById.get(gate.source), target = state.nodesById.get(gate.target);
        const routeLeg = state.route?.legs.get(gateKey(gate.source, gate.target));
        if (!source || !target || (!routeLeg && (!visibleNode(source) || !visibleNode(target)))) return;
        const physicalDistance = Math.hypot(source.position_m.x - target.position_m.x, source.position_m.y - target.position_m.y, source.position_m.z - target.position_m.z);
        if (state.layoutMode !== 'tactical' && physicalDistance > 8e16 && !routeLeg) return;
        const clipped = projectGateSegment(source, target, camera, width, height);
        if (!clipped) return;
        let a = clipped.a, b = clipped.b;
        const key = gateKey(gate.source, gate.target);
        const gateCameraDistance = Math.hypot(camera.position.x - (source.x + target.x) / 2, camera.position.y - (source.y + target.y) / 2, camera.position.z - (source.z + target.z) / 2);
        const distantFromCamera = gateCameraFade(gateCameraDistance) <= .42;
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 8) gateHoverTargets.push({ key, source, target, a, b });
        if (state.filters.traffic) {
          const estimated = estimateGateFlows(source, target, state.gateDegrees, trafficBySystem);
          const activity = Math.round((estimated.sourceEndpoint + estimated.targetEndpoint) / 2);
          const directionalFlows = [
            { direction: 1, plan: trafficParticlePlan(estimated.sourceEndpoint, currentGraphicsProfile().trafficParticleBudget) },
            { direction: -1, plan: trafficParticlePlan(estimated.targetEndpoint, currentGraphicsProfile().trafficParticleBudget) },
          ].filter(flow => flow.plan.count);
          if (directionalFlows.length && Math.hypot(b.x - a.x, b.y - a.y) >= 18) {
            const intensity = trafficStrength(activity);
            trafficSegments.push({ a, b, flows: directionalFlows, intensity, worldLength: trafficSegmentWorldLength({ source, target }), phase: (((Number(gate.source) * 31) ^ Number(gate.target)) >>> 0) % 997 / 997 });
          }
        }
        if (routeLeg) {
          if (routeLeg.source === target.id) [a, b] = [b, a];
          routeSegments.push({ a, b, index: routeLeg.index });
          return;
        }
        const emphasisKind = gateEmphasisKind({ key, source, target }, gateEmphasis);
        if (state.layoutMode === 'tactical' && state.tactical2D) {
          const selected = Number(source.id) === Number(state.selectedSystemId) || Number(target.id) === Number(state.selectedSystemId);
          const priority = selected ? 3 : emphasisKind ? 2 : 0;
          flatGates[priority].push({a,b,priority,kind:selected?'ACTIVE_STARGATE_ROUTE':emphasisKind==='combat'?'LIVE_INTEL_DANGER':'STARGATE',hops:Math.max(source.hops ?? 5,target.hops ?? 5)});
          return;
        }
        if (state.areaFocus && isAreaMember(source) && isAreaMember(target)) focusSegments.push(a.x, a.y, b.x, b.y);
        if (emphasisKind) tacticalSegments[emphasisKind].push(a.x, a.y, b.x, b.y);
        const sourceBand = security(source.security), targetBand = security(target.security);
        const regional = source.region_id !== target.region_id;
        if (sourceBand !== targetBand) {
          // The safety transitions are rare enough to draw individually. This
          // preserves a readable directional gradient without thousands of draw calls.
          boundarySegments.push({ a, b, sourceSecurity: source.security, targetSecurity: target.security, regional, cameraFade: gateCameraFade(gateCameraDistance) });
        } else {
          (regional ? (distantFromCamera ? distantRegionalSegments : regionalSegments) : (distantFromCamera ? distantLocalSegments : localSegments)).push(a.x, a.y, b.x, b.y);
        }
      });
      const stroke = (segments, color, lineWidth) => { if (!segments.length) return; context.beginPath(); for (let i = 0; i < segments.length; i += 4) { context.moveTo(segments[i], segments[i + 1]); context.lineTo(segments[i + 2], segments[i + 3]); } context.strokeStyle = color; context.lineWidth = lineWidth; context.stroke(); };
      const normalStroke=(segments,opacity,width)=>{
        context.save(); window.EveMapStyles.applyLine(context,'STARGATE',{opacity,width});
        stroke(segments,window.EveMapStyles.registry.STARGATE.color,width); context.restore();
      };
      normalStroke(localSegments,gateStyle.localAlpha,gateStyle.localWidth);
      normalStroke(distantLocalSegments,gateStyle.localAlpha*gateStyle.farTopologyFloor,gateStyle.localWidth);
      normalStroke(regionalSegments,gateStyle.regionalAlpha,gateStyle.regionalWidth);
      normalStroke(distantRegionalSegments,gateStyle.regionalAlpha*gateStyle.farTopologyFloor,gateStyle.regionalWidth);
      if (focusSegments.length) stroke(focusSegments, 'rgba(201, 250, 255, .68)', gateStyle.emphasisWidth);
      stroke(tacticalSegments.tactical, 'rgba(202, 250, 255, .66)', gateStyle.emphasisWidth);
      // A character-connected gate is the strongest tactical cue.  Combat is
      // deliberately softer than before so a distant R2Z2 event cannot wash
      // out the rest of New Eden.
      context.save();
      window.EveMapStyles.applyLine(context,'LIVE_INTEL_DANGER',{opacity:gateStyle.combatAlpha});
      stroke(tacticalSegments.combat, window.EveMapStyles.registry.LIVE_INTEL_DANGER.color, window.EveMapStyles.registry.LIVE_INTEL_DANGER.width);
      context.restore();
      stroke(tacticalSegments.hover, 'rgba(226, 255, 255, .82)', gateStyle.emphasisWidth + .22);
      stroke(tacticalSegments.character, `rgba(125, 246, 255, ${gateStyle.characterAlpha})`, gateStyle.characterWidth);
      boundarySegments.forEach(({ a, b, sourceSecurity, targetSecurity, regional, cameraFade }) => {
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
        context.strokeStyle = window.EveMapStyles.registry.STARGATE.color;
        context.globalAlpha = gateStyle.boundaryAlpha * (regional ? 1 : .84) * cameraFade;
        context.lineWidth = gateStyle.boundaryWidth * (regional ? 1 : .9);
        context.stroke();
      });
      trafficSegments.forEach(({ a, b, intensity }) => {
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
        context.strokeStyle = `hsla(${190 - intensity * 24}, 82%, 66%, ${.13 + intensity * .19})`;
        context.lineWidth = .54 + intensity * .72; context.stroke();
      });
      const drawFlatGate = ({a,b,priority,hops,kind}) => {
        const style = window.EveMapTactical.visualHierarchy(hops,priority);
        window.EveMapStyles.applyLine(context,kind,{opacity:style.opacity,width:kind==='LIVE_INTEL_DANGER'?window.EveMapStyles.registry[kind].width:style.width});
        context.beginPath(); context.moveTo(a.x,a.y); context.lineTo(b.x,b.y); context.stroke();
      };
      flatGates[0].forEach(drawFlatGate);
      flatGates[2].forEach(drawFlatGate);
      drawTacticalOverlays(context,camera,width,height,'links');
      drawJumpRoute(context,camera,width,height,'links');
      flatGates[3].forEach(drawFlatGate);
      context.setLineDash?.([]);
      routeSegments.forEach(({ a, b, index }) => {
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
        window.EveMapStyles.applyLine(context,'ACTIVE_STARGATE_ROUTE'); context.stroke();
        const progress = (now / 850 + index * .18) % 1;
        const particleX = a.x + (b.x - a.x) * progress, particleY = a.y + (b.y - a.y) * progress;
        context.beginPath(); context.arc(particleX, particleY, 1 + gateStyle.emphasisWidth, 0, Math.PI * 2);
        context.fillStyle = window.EveMapStyles.registry.ACTIVE_STARGATE_ROUTE.color; context.fill();
      });
      trafficSegments.forEach(({ a, b, flows, phase, worldLength }) => {
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
        flows.forEach(({ direction, plan }, flowIndex) => {
          const progress = trafficSegmentProgress(now, phase + flowIndex * .37, plan.jumps, { worldLength });
          // Each direction owns a separate side of the line. Its tiered
          // particles form a small sequential packet, rather than a row.
          const laneOffset = direction * 2;
          trafficPacketOffsets(plan.count).forEach((packetOffset, index) => {
            const packetProgress = (progress - packetOffset + 1) % 1;
            const packetTravel = direction === 1 ? packetProgress : 1 - packetProgress;
            const particle = plan.particles[index];
            const visual = trafficParticleVisualStyle(particle, currentGraphicsProfile());
            const x = a.x + dx * packetTravel - dy / length * laneOffset, y = a.y + dy * packetTravel + dx / length * laneOffset;
            context.beginPath(); context.arc(x, y, visual.glowRadius, 0, Math.PI * 2); context.fillStyle = particle.color; context.globalAlpha = visual.glowAlpha; context.fill();
            context.beginPath(); context.arc(x, y, visual.coreRadius, 0, Math.PI * 2); context.fillStyle = particle.color; context.globalAlpha = visual.coreAlpha; context.fill();
          });
        });
      });
      state.gateHoverTargets = gateHoverTargets;
      state.perf.visibleGates = gateHoverTargets.length;
      context.globalAlpha = 1;
      if (state.filters.traffic || state.filters.danger) {
        for (const { node, point } of nodeView.rows) {
          const live = liveFor(node);
          if (state.filters.traffic && live.ship_jumps > 0) {
            const intensity = trafficStrength(live.ship_jumps), style = trafficNodeStyle(live.ship_jumps);
            context.beginPath(); context.arc(point.x, point.y, style.radius, 0, Math.PI * 2); context.fillStyle = `hsla(${190 - intensity * 24}, 86%, 66%, ${style.alpha})`; context.fill();
          }
          if (state.filters.danger && live.danger >= 20) {
            const colors = { yellow: '#ffd35f', orange: '#ff913d', red: '#f0546e' };
            context.beginPath(); context.arc(point.x, point.y, 3.3 + live.danger / 30, 0, Math.PI * 2); context.strokeStyle = colors[live.danger_band]; context.globalAlpha = .18 + live.danger / 340; context.lineWidth = 1.05; context.stroke();
          }
        }
      }
      if (state.filters.sovereignty || state.filters.empires) {
        context.save();
        for (const { node, point, distance } of nodeView.rows) {
          const layers = influenceLayers(node);
          const far = Math.max(0, Math.min(1, (distance - 300) / 2200));
          layers.forEach(layer => {
            const style = influenceOverlayStyle(distance, layer.kind), radius = style.radius + layer.offset * 2.2;
            context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2);
            // At distance the translucent fills overlap into territories.  Do
            // not outline every system: the rings were visually competing with
            // the actual node layer and made dense regions look like clusters.
            context.fillStyle = influenceColor(layer.id); context.globalAlpha = layer.alpha * style.opacity; context.fill();
            if (far < .25) { context.strokeStyle = influenceColor(layer.id); context.globalAlpha = layer.alpha * .45; context.lineWidth = .55; context.stroke(); }
          });
        }
        context.restore();
      }
      characterGroups().forEach(characters => {
        const node = state.nodesById.get(characters[0].system_id), point = node && projectVisible(node, camera, width, height);
        if (!point || point.x < 0 || point.x > width || point.y < 0 || point.y > height) return;
        const distance = Math.hypot(camera.position.x - node.x, camera.position.y - node.y, camera.position.z - node.z);
        const effectiveRadius=effectiveTacticalRadius(node);
        const markerScale = characterMarkerScale(distance), ringRadius = effectiveRadius?effectiveRadius*1.8:5 + markerScale * 1.8, ringWidth = effectiveRadius?effectiveRadius*.45:2.5 + markerScale * .95;
        characterRingSegments(characters).forEach(segment => {
          context.save(); context.lineCap = 'butt'; context.beginPath(); context.arc(point.x, point.y, ringRadius, segment.start, segment.end);
          context.globalAlpha = .20 * currentGraphicsProfile().decorativeGlow; context.strokeStyle = segment.glow; context.lineWidth = ringWidth + 4; context.shadowColor = segment.glow; context.shadowBlur = (10 + markerScale * 3) * currentGraphicsProfile().decorativeGlow; context.stroke();
          context.beginPath(); context.arc(point.x, point.y, ringRadius, segment.start, segment.end); context.globalAlpha = .96; context.strokeStyle = segment.color; context.lineWidth = ringWidth; context.shadowBlur = 4 * currentGraphicsProfile().decorativeGlow; context.stroke(); context.restore();
        });
        const outerRadius = ringRadius + ringWidth / 2;
        context.font = `600 ${Math.min(14, 8.5 + markerScale * 1.45)}px system-ui, sans-serif`; context.textAlign = 'left';
        const lineHeight = 9 + markerScale * 2.25, ledSize = 3 + markerScale * 1.1, textOffset = outerRadius + 7;
        const firstLineY = point.y - outerRadius - 3 - (characters.length - 1) * lineHeight / 2;
        characters.forEach((character, index) => {
          const lineY = firstLineY + index * lineHeight;
          context.fillStyle = characterColor(character); context.fillRect(point.x + textOffset, lineY - ledSize, ledSize, ledSize);
          context.fillStyle = '#e3fbff'; context.fillText(character.name, point.x + textOffset + ledSize + 5, lineY);
        });
      });
      context.globalAlpha = 1;
    } else { state.gateHoverTargets = []; state.perf.visibleGates = 0; drawJumpRoute(context,camera,width,height,'links'); }
    drawTacticalOverlays(context,camera,width,height,'nodes');
    drawJumpRoute(context,camera,width,height,'nodes');
    drawSystemPreselection(context, camera, width, height);
    drawSelectedSystemReticle(context, camera, width, height, now);
    drawCombatMarkers(context, camera, width, height); state.perf.combatDraws += 1;
    drawMapLabels(context, camera, width, height, nearestSystemDistance); state.perf.labelDraws += 1;
    state.perf.overlayFrames += 1; state.overlayDirty.clear();
    state.perf.overlayFrameTimeMs = performance.now() - now;
  }
  function startGateOverlay(host, nodes) {
    stopGateOverlay();
    const canvas = document.createElement('canvas'); canvas.className = 'eve-map-links'; canvas.setAttribute('aria-hidden', 'true'); Object.assign(canvas.style, { position: 'absolute', inset: '0', zIndex: '2', pointerEvents: 'none' }); host.appendChild(canvas);
    state.linkCanvas = canvas; state.renderNodes = nodes; state.nodesById = new Map(nodes.map(node => [node.id, node])); state.labelGroups = { regions: buildLabelGroups(nodes, 'region_id', 'region'), constellations: buildLabelGroups(nodes, 'constellation_id', 'constellation') }; markOverlayDirty('topology');
  }
  function focus(system) {
    if (!system || !state.graph) return;
    if (state.layoutMode === 'tactical' && state.tactical2D) {
      if (!state.renderNodes.some(node => Number(node.id) === Number(system.id))) {
        state.selectedSystemId = Number(system.id);
        setLayoutMode('tactical', system.id, {reframe:false});
      }
      showSystem(state.nodesById.get(system.id));
      return;
    }
    if (state.layoutMode === 'tactical') { setLayoutMode('tactical', system.id); showSystem(state.nodesById.get(system.id)); return; }
    // Search results come from the raw dataset; resolve them to the pinned render
    // node before using scene coordinates for the camera handoff.
    const renderedSystem = state.nodesById?.get(system.id) || system;
    if (!['x', 'y', 'z'].every(axis => Number.isFinite(renderedSystem[axis]))) return;
    state.areaFocus = null; render(); showSystem(renderedSystem);
    const controls = typeof state.graph.controls === 'function' ? state.graph.controls() : null;
    animateCameraFor(700);
    state.graph.cameraPosition(cameraFocusPosition(renderedSystem, state.graph.camera?.(), controls, 42), renderedSystem, 700);
  }
  function focusSystemPreset(system) {
    if (!system || !state.graph) return false;
    const renderedSystem = state.nodesById?.get(system.id) || system;
    if (!['x', 'y', 'z'].every(axis => Number.isFinite(renderedSystem[axis]))) return false;
    state.areaFocus = null; render(); showSystem(renderedSystem);
    // Unlike a regular system click, a discrete zoom preset must establish its
    // own scale rather than retain the current galaxy/constellation offset.
    const duration = 700, distance = 130;
    animateCameraFor(duration);
    state.graph.cameraPosition(cameraPose(renderedSystem, distance), renderedSystem, duration);
    return true;
  }
  // One deliberate, overhead New Eden frame. Home, search, and right-click
  // focus all use this vector so navigation translates over the map instead
  // of unexpectedly changing its orbital plane.
  const NEW_EDEN_CAMERA_DIRECTION = { x: .2, y: 1.9, z: .35 };
  const newEdenCameraPose = (target, distance) => {
    const direction = NEW_EDEN_CAMERA_DIRECTION;
    const magnitude = Math.hypot(direction.x, direction.y, direction.z) || 1;
    return { x: target.x + direction.x / magnitude * distance, y: target.y + direction.y / magnitude * distance, z: target.z + direction.z / magnitude * distance };
  };
  function cameraPose(target, distance) { return newEdenCameraPose(target, distance); }
  function cameraFocusPosition(target, camera, controls, fallbackDistance = 42) {
    const position = camera?.position, currentTarget = controls?.target;
    const valid = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]));
    if (valid(target) && valid(position) && valid(currentTarget)) {
      // Translate the complete camera rig to the new node.  The offset between
      // the camera and its orbit target is unchanged, hence repeated picks do
      // not snap the view back to a fixed overhead angle.
      const offset = { x: position.x - currentTarget.x, y: position.y - currentTarget.y, z: position.z - currentTarget.z };
      if (Math.hypot(offset.x, offset.y, offset.z) > .001) return { x: target.x + offset.x, y: target.y + offset.y, z: target.z + offset.z };
    }
    return cameraPose(target, fallbackDistance);
  }
  function galaxyShot(nodes, anchor = null) {
    const bounds = nodes.reduce((result, node) => {
      ['x', 'y', 'z'].forEach(axis => { result.min[axis] = Math.min(result.min[axis], node[axis]); result.max[axis] = Math.max(result.max[axis], node[axis]); });
      return result;
    }, { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } });
    const centre = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, (bounds.min[axis] + bounds.max[axis]) / 2]));
    const jita = nodes.find(node => Number(node.id) === 30000142 || node.name === 'Jita');
    const target = anchor || jita || centre;
    const span = Math.max(...['x', 'y', 'z'].map(axis => bounds.max[axis] - bounds.min[axis]), 1);
    return { target, position: newEdenCameraPose(target, span * 1.94) };
  }
  const MAP_ZOOM_PRESETS = [
    { name: 'System', hint: 'System — zoom in' },
    { name: 'Constellation', hint: 'Constellation — refine view' },
    { name: 'Region', hint: 'Region — reset camera' },
  ];
  function setMapZoomPresetHint(level) {
    const preset = MAP_ZOOM_PRESETS[level] || MAP_ZOOM_PRESETS[2], input = document.getElementById('eve-map-zoom-preset');
    if (!input) return;
    input.value = String(level); input.title = preset.hint;
    input.setAttribute('aria-valuetext', preset.hint);
    input.closest?.('.eve-map-zoom-preset')?.setAttribute('title', `System: zoom in · Constellation: refine view · Region: reset camera\nCurrent: ${preset.hint}`);
  }
  function focusHome(duration = 650) { if (!state.graph || !state.nodesById) return; setMapZoomPresetHint(2); state.areaFocus = null; render(); const shot = galaxyShot([...state.nodesById.values()]); animateCameraFor(duration); state.graph.cameraPosition(shot.position, shot.target, duration); }
  function setMapZoomPreset(level) {
    const preset = Math.max(0, Math.min(2, Math.round(Number(level) || 0)));
    setMapZoomPresetHint(preset);
    if (preset === 2) { focusHome(); return 'global'; }
    const anchor = state.nodesById?.get(Number(state.selectedSystemId)) || state.nodesById?.get(30000142) || [...(state.nodesById?.values?.() || [])][0];
    if (!anchor) return null;
    if (preset === 0) { focusSystemPreset(anchor); return 'system'; }
    const constellation = state.labelGroups?.constellations?.find(group => Number(group.id) === Number(anchor.constellation_id));
    if (!constellation) return null;
    focusArea(constellation, 'constellation'); return 'constellation';
  }
  function focusArea(area, kind) {
    if (!area || !state.graph) return;
    state.areaFocus = { area, kind }; render();
    // Each preset lands inside its intended LOD. The former constellation
    // minimum of 150 was still a system view, which skipped its labels.
    const distance = kind === 'region'
      ? Math.max(1120, area.span * 1.7)
      : Math.max(650, area.span * 1.8);
    animateCameraFor(850);
    state.graph.cameraPosition(cameraPose(area, distance), area, 850);
    renderPanelSelection({ kind, target: area });
  }
  function systemFor(id) {
    const numericId = Number(id);
    // Render nodes copy the static SDE fields and are indexed once on map open.
    // This keeps full-world label aggregation O(systems + areas), not O(systems²).
    return state.nodesById?.get(numericId) || state.data?.systems.find(system => String(system.id) === String(id));
  }
  function togglePanelSection(key) {
    if (!Object.prototype.hasOwnProperty.call(state.panelSections, key)) return false;
    state.panelSections[key] = !state.panelSections[key];
    const section = document.querySelector?.(`[data-eve-panel-section="${key}"]`);
    section?.classList?.[state.panelSections[key] ? 'add' : 'remove']('is-open');
    const title = section?.querySelector?.('.eve-map-section-title');
    if (title) { title.setAttribute('aria-expanded', String(state.panelSections[key])); const chevron = title.querySelector('b'); if (chevron) chevron.textContent = state.panelSections[key] ? '▲' : '▼'; }
    return state.panelSections[key];
  }
  function setPanelCollapsed(collapsed) {
    state.panelCollapsed = Boolean(collapsed); closeKillPopover();
    const content = document.getElementById('eve-map-content'), panel = document.getElementById('eve-map-panel'), button = document.getElementById('eve-map-panel-toggle');
    content?.classList?.[state.panelCollapsed ? 'add' : 'remove']('eve-map-panel-collapsed');
    panel?.setAttribute?.('aria-hidden', String(state.panelCollapsed));
    if (button) {
      const action = state.panelCollapsed ? 'Show intel panel' : 'Hide intel panel';
      button.setAttribute('aria-expanded', String(!state.panelCollapsed));
      button.setAttribute('aria-label', action);
      button.title = action;
      button.textContent = state.panelCollapsed ? '▧' : '▣';
    }
    return state.panelCollapsed;
  }
  function setEndpoint(kind, system) {
    const rawSystem = systemFor(system?.id || system);
    if (!rawSystem) return;
    if (kind === 'origin') { state.originId = rawSystem.id; const input = document.getElementById('eve-route-from'); if (input) input.value = rawSystem.name; }
    else { state.destinationId = rawSystem.id; const input = document.getElementById('eve-route-to'); if (input) input.value = rawSystem.name; }
    if (state.originId && state.destinationId) updateRoute();
  }
  function routeAvoidanceMarkup() {
    const settings = state.routePreferences, entries = (settings.entries || []).map((entry, index) => `<button class="eve-route-avoid-entry" type="button" data-eve-route-avoid-remove="${index}" title="Remove avoidance">${escapeHtml(entry.kind)} · ${escapeHtml(entry.name)} ×</button>`).join('');
    const selection = state.panelSelection;
    const canAdd = ['system', 'constellation', 'region'].includes(selection?.kind);
    return `<div class="eve-route-avoidance"><b>AVOID</b><label><input id="eve-route-avoid-incursion" type="checkbox"${settings.avoid_incursions ? ' checked' : ''}> Incursions</label><label><input id="eve-route-avoid-hotspot" type="checkbox"${settings.avoid_recent_hotspots ? ' checked' : ''}> Recent R2Z2 hotspots</label>${canAdd ? `<button class="btn mini" id="eve-route-avoid-add" type="button">Avoid selected ${escapeHtml(selection.kind)}</button>` : '<small>Select a system, constellation or region to add it.</small>'}<div class="eve-route-avoid-entries">${entries || '<small>No explicit exclusions.</small>'}</div></div>`;
  }
  function renderRouteAvoidance() {
    const host = document.getElementById('eve-route-avoidance'); if (!host) return;
    host.innerHTML = routeAvoidanceMarkup();
    host.querySelector('#eve-route-avoid-incursion')?.addEventListener('change', event => saveRoutePreferences({ avoid_incursions: event.target.checked }));
    host.querySelector('#eve-route-avoid-hotspot')?.addEventListener('change', event => saveRoutePreferences({ avoid_recent_hotspots: event.target.checked }));
    host.querySelector('#eve-route-avoid-add')?.addEventListener('click', addSelectedRouteAvoidance);
    host.querySelectorAll('[data-eve-route-avoid-remove]').forEach(button => button.addEventListener('click', () => {
      const entries = [...(state.routePreferences.entries || [])]; entries.splice(Number(button.dataset.eveRouteAvoidRemove), 1); saveRoutePreferences({ entries });
    }));
  }
  async function loadRoutePreferences() {
    if (!api()?.get_eve_map_route_preferences) return;
    const response = await api().get_eve_map_route_preferences();
    if (response?.settings) state.routePreferences = response.settings;
    renderRouteAvoidance();
  }
  async function saveRoutePreferences(values) {
    state.routePreferences = { ...state.routePreferences, ...values };
    renderRouteAvoidance();
    const response = await api()?.set_eve_map_route_preferences?.(state.routePreferences);
    if (response?.settings) state.routePreferences = response.settings;
    renderRouteAvoidance();
    if (state.originId && state.destinationId) updateRoute();
  }
  function addSelectedRouteAvoidance() {
    const selection = state.panelSelection, target = selection?.target;
    if (!selection || !target || !['system', 'constellation', 'region'].includes(selection.kind)) return;
    const entries = [...(state.routePreferences.entries || [])];
    if (!entries.some(entry => entry.kind === selection.kind && Number(entry.id) === Number(target.id))) entries.push({ kind: selection.kind, id: Number(target.id), name: target.name });
    saveRoutePreferences({ entries });
  }
  async function setEveMapWaypoint(systemId) {
    const pilot = state.selectedCharacterId;
    const response = await api()?.set_eve_map_waypoint?.(Number(systemId), pilot);
    const result = document.getElementById('eve-route-result');
    if (result) result.textContent = response?.ok ? 'Waypoint sent to EVE.' : `Waypoint unavailable: ${response?.error || 'select a MMD pilot and re-consent the waypoint scope.'}`;
  }
  async function sendEveMapRouteToEve(replace) {
    const response = await api()?.send_eve_map_route_waypoints?.(state.route?.systems || [], state.selectedCharacterId, Boolean(replace));
    const result = document.getElementById('eve-route-result');
    if (result) result.textContent = response?.ok ? `${response.queued} waypoint(s) queued for EVE.` : `Route export unavailable: ${response?.error || 'select a MMD pilot and re-consent the waypoint scope.'}`;
  }
  function traceRouteFromInputs() {
    const systems = state.data?.systems || [], fromValue = document.getElementById('eve-route-from')?.value?.trim() || '', toValue = document.getElementById('eve-route-to')?.value?.trim() || '';
    const resolve = value => systems.find(system => String(system.id) === value || system.name.toLowerCase() === value.toLowerCase());
    const from = resolve(fromValue), to = resolve(toValue), result = document.getElementById('eve-route-result');
    if (!from || !to) { if (result) result.textContent = 'Systems not found.'; return false; }
    state.originId = from.id; state.destinationId = to.id; updateRoute(); return true;
  }
  function clearRoute() {
    state.originId = null; state.destinationId = null; state.route = null;
    const from = document.getElementById('eve-route-from'), to = document.getElementById('eve-route-to'), result = document.getElementById('eve-route-result');
    if (from) from.value = ''; if (to) to.value = ''; if (result) result.textContent = '';
    return true;
  }
  async function updateRoute(safeOnly = false) {
    const result = document.getElementById('eve-route-result');
    const from = systemFor(state.originId), to = systemFor(state.destinationId);
    if (!from || !to) return;
    result.textContent = 'Calculating route…'; state.route = null;
    const response = await api().find_eve_route(from.id, to.id, safeOnly ? 'high' : null), route = response.data;
    if (!route || route.error) { result.textContent = safeOnly ? 'No fully high-sec route.' : 'No stargate route found.'; return; }
    const legs = new Map(route.systems.slice(1).map((target, index) => {
      const source = route.systems[index]; return [gateKey(source, target), { source, target, index }];
    }));
    state.route = { systems: route.systems, legs };
    const risky = route.systems.some(id => Number(systemFor(id)?.security) < .6);
    const steps = route.systems.map((id, index) => {
      const system = systemFor(id);
      if (!system) return '';
      const endpoint = index === 0 ? ' eve-route-square--origin' : index === route.systems.length - 1 ? ' eve-route-square--destination' : '';
      const title = `${system.name} · ${Number(system.security || 0).toFixed(2)}`;
      return `<button class="eve-route-square eve-route-square--${security(system.security)} ${dangerClass(system)}${endpoint}" title="${escapeHtml(title)} · Danger ${liveFor(system).danger}/100" aria-label="Centrer sur ${escapeHtml(title)}" onclick="focusEveMapSystem(${Number(system.id)})"></button>`;
    }).filter(Boolean).join('<span class="eve-route-square-join" aria-hidden="true"></span>');
    const routeIntel = route.systems.map(systemFor).filter(Boolean).map(liveFor), totalJumps = routeIntel.reduce((sum, live) => sum + live.ship_jumps, 0), shipKills = routeIntel.reduce((sum, live) => sum + live.ship_kills, 0), podKills = routeIntel.reduce((sum, live) => sum + live.pod_kills, 0), riskyIntel = routeIntel.filter(live => live.danger >= 50).length, dangerous = routeIntel.filter(live => live.danger >= 75).length;
    const traffic = totalJumps >= 5000 ? 'HIGH' : totalJumps >= 500 ? 'MEDIUM' : 'LOW';
    const intelSummary = state.live.state === 'unavailable' ? '<div class="eve-live-state">Live Intel unavailable</div>' : `<div class="eve-route-intel"><b>Traffic: ${traffic}</b><span>Danger: ${riskyIntel} risky · ${dangerous} dangerous</span><span>Ship kills: ${shipKills} · Pod kills: ${podKills}</span></div>`;
    const avoidance = route.avoidance_count ? `<small>${route.avoidance_count} avoided system${route.avoidance_count === 1 ? '' : 's'} active.</small>` : '';
    result.innerHTML = `<div class="eve-route-summary">${route.jumps} jump${route.jumps === 1 ? '' : 's'} · ${escapeHtml(from.name)} → ${escapeHtml(to.name)}</div>${intelSummary}${avoidance}${risky && !safeOnly ? '<div class="eve-route-warning">⚠ Route drops below 0.6 <button class="btn mini" onclick="useEveMapSafeRoute()">High-sec route</button></div>' : safeOnly ? '<div class="eve-route-safe">✓ High-sec route (displayed ≥ 0.5)</div>' : ''}<div class="eve-route-steps" aria-label="Systems on route">${steps}</div><div class="eve-route-actions eve-route-export"><button class="btn mini" onclick="sendEveMapRouteToEve(true)">Send to EVE</button><button class="btn mini" onclick="sendEveMapRouteToEve(false)">Append</button></div>`;
  }
  function onNodeClick(system, options = {}) {
    if (!options.picker && performance.now() < state.suppressNodeClickUntil) return;
    const now = performance.now(), previous = state.lastNodeClick;
    if (previous?.id === system?.id && now - previous.at < 360) { setEndpoint('destination', system); state.lastNodeClick = null; return; }
    state.lastNodeClick = { id: system?.id, at: now }; focus(system);
  }
  function initialize(data) {
    state.data = data; state.gateDegrees = buildGateDegrees(data.gates); const host = document.getElementById('eve-map-canvas'); host.textContent = '';
    // ForceGraph3D is only our WebGL renderer.  Pin all CCP coordinates so its
    // default D3 physics can never turn New Eden into a force-directed cluster.
    const nodes = displayNodes(data.systems, data.gates);
    let graph;
    graph = ForceGraph3D({ controlType: 'orbit' })(host).backgroundColor('rgba(7, 17, 28, 0)').graphData({ nodes, links: data.gates }).nodeId('id').nodeLabel(node => `${node.name} · ${node.security.toFixed(2)}`).nodeColor(focusNodeColor).nodeVal(nodeSize).nodeRelSize(.14).nodeResolution(12).nodeOpacity(.96).linkColor(() => '#70e6ef').linkOpacity(.9).linkWidth(0).enableNodeDrag(false).nodePositionUpdate((object, coords) => {
      // Position only; the synchronized overlay is the sole scale owner.
      object.position.set(coords.x, coords.y, coords.z);
      nodeView.key = null;
      return true;
    }).onNodeClick(onNodeClick).onNodeRightClick(node => { setEndpoint('origin', node); focus(node); }).onBackgroundClick(() => { if (performance.now() >= state.suppressNodeClickUntil) clearSystemSelection(); }).onNodeHover(node => host.style.cursor = node ? 'pointer' : 'grab');
    const resizeMap = () => { if (!host.clientWidth || !host.clientHeight) return; graph.width(host.clientWidth).height(host.clientHeight); state.lastLinkDraw = 0; markOverlayDirty('resize'); };
    state.resizeMap = resizeMap; resizeMap();
    if (window.ResizeObserver) { state.resizeObserver?.disconnect(); state.resizeObserver = new window.ResizeObserver(resizeMap); state.resizeObserver.observe(host); }
    else window.addEventListener?.('resize', resizeMap);
    enableDistancePicker(host);
    state.physicalNodes = nodes;
    state.layoutMode = 'physical'; state.tacticalRadius = 3;
    state.layoutForces = { charge: graph.d3Force('charge'), link: graph.d3Force('link') };
    graph.d3Force('charge', null); graph.d3Force('link', null); graph.d3Force('center', null); graph.cooldownTicks(0);
    const controls = typeof graph.controls === 'function' ? graph.controls() : null;
    stabilizeOrbitControls(controls); bindSkyQualityControls(controls);
    state.graph = graph;
    render(); startSkyMap(host); startGateOverlay(host, nodes); setTimeout(() => focusHome(), 80);
    installRenderMetrics(graph, host);
    if(state.jumpRouteState)window.setEveMapJumpRoute(state.jumpRouteState);
  }
  function setLayoutMode(mode, systemId = state.selectedSystemId, { reframe = true } = {}) {
    if (!state.graph || !window.EveMapTactical || !state.physicalNodes) return false;
    const next = mode === 'tactical' ? 'tactical' : 'physical';
    const physicalById = new Map(state.physicalNodes.map(node => [Number(node.id), node]));
    const numericGates = state.data.gates.map(gate => ({ source: Number(gate.source?.id ?? gate.source), target: Number(gate.target?.id ?? gate.target), kind: 'STARGATE' }));
    let nodes = state.physicalNodes, gates = numericGates;
    if (next === 'tactical') {
      const centreId = state.tactical2D
        ? window.EveMapTactical.radialReference(characterPositionSystemId(state.selectedCharacterId),
          window.EveJumpPlanner?.getOriginSystemId?.() || state.jumpRouteState?.origin_id || state.jumpRouteState?.route?.systems?.[0],
          state.radialReferenceId, systemId || 30000142, physicalById)
        : Number(systemId || state.tacticalCentre || 30000142);
      state.tacticalTopology ||= window.EveMapTactical.createTopology(state.data.systems, numericGates);
      // Reachability highlights existing nodes, not the entire LY ball.
      const jumpWorkingSet=new Set(tacticalSystemIds());
      const packingPriorities=new Map([...jumpWorkingSet].map(id=>[Number(id),3]));
      for (const character of state.characters) packingPriorities.set(Number(character.system_id),4);
      if (state.selectedSystemId) packingPriorities.set(Number(state.selectedSystemId),5);
      const layout = state.tactical2D
        ? state.tacticalTopology.buildHybridLayout(centreId, state.tacticalRadius || 3, jumpWorkingSet, packingPriorities)
        : state.tacticalTopology.buildTacticalLayout(centreId, state.tacticalRadius || 3, jumpWorkingSet);
      const rawById = new Map(state.data.systems.map(system => [Number(system.id), system]));
      nodes = layout.nodes.map(node => {
        // Copy metadata, not ForceGraph objects/geometry or Physical pins.
        const raw = rawById.get(node.id);
        return { ...raw, ...node };
      });
      gates = layout.links;
      state.tacticalCentre = centreId;
      if (state.tactical2D) state.radialReferenceId = centreId;
    }
    state.layoutMode = next; state.activeGates = gates;
    if(jumpSphere)jumpSphere.visible=next==='physical';
    Object.assign(state.perf, { layoutMode: next, workingSetNodes: nodes.length, workingSetGates: gates.length });
    state.renderNodes = nodes;
    state.nodesById = new Map(physicalById);
    nodes.forEach(node => state.nodesById.set(Number(node.id), node));
    state.preselectedSystem = null; state.hoverCandidate = null; state.labelVisibility.clear();
    state.areaFocus = null;
    state.labelGroups = { regions: buildLabelGroups(nodes, 'region_id', 'region'), constellations: buildLabelGroups(nodes, 'constellation_id', 'constellation') };
    // Only the graph's working set changes; the scene, renderer and controls survive.
    state.graph.graphData({ nodes, links: gates.map(gate => ({ ...gate })) });
    window.EveMapTactical.applyForces(state.graph, next, state.layoutForces, state.tactical2D);
    render(); markOverlayDirty('layout');
    const shot = galaxyShot(next === 'tactical' ? nodes.filter(node => node.inNeighborhood) : nodes, next === 'tactical' ? state.nodesById.get(state.tacticalCentre) : null);
    if (reframe) animateCameraFor(650);
    const camera = state.graph.camera?.(), flat = next === 'tactical' && state.tactical2D;
    setFlatCameraControls(state.graph.controls?.(), flat);
    if (flat && camera?.up && !state.beforeFlatUp) state.beforeFlatUp = {x:camera.up.x,y:camera.up.y,z:camera.up.z};
    if (flat) camera?.up?.set(0,0,-1);
    else if (state.beforeFlatUp) { const up = state.beforeFlatUp; camera?.up?.set(up.x,up.y,up.z); state.beforeFlatUp = null; }
    const distance = Math.max(160, Math.hypot(shot.position.x-shot.target.x, shot.position.y-shot.target.y, shot.position.z-shot.target.z)*.65);
    if (reframe) state.graph.cameraPosition(next === 'tactical' ? {x:shot.target.x, y:shot.target.y+(flat ? distance : 0), z:shot.target.z+(flat ? 0 : distance)} : shot.position, shot.target, 650);
    const select = document.getElementById('eve-map-layout'); if (select) select.checked = next === 'tactical';
    const radius = document.getElementById('eve-map-tactical-radius'); if (radius) radius.disabled = next !== 'tactical';
    const radiusControl = document.getElementById('eve-map-tactical-radius-control'); if (radiusControl) radiusControl.hidden = next !== 'tactical';
    const flatInput = document.getElementById('eve-map-tactical-2d'); if (flatInput) flatInput.disabled = next !== 'tactical';
    const flatControl = document.getElementById('eve-map-tactical-2d-control'); if (flatControl) flatControl.hidden = next !== 'tactical';
    return true;
  }
  window.setEveMapLayoutMode = setLayoutMode;
  async function load() { if (state.graph) return; if (!window.ForceGraph3D) throw new Error('La dépendance 3D est indisponible.'); const response = await api().get_eve_map_data(); if (!response.ok) throw new Error(response.error || 'Carte indisponible'); initialize(response.data); }
  window.openEveMap = async function () { const workspace = mapWorkspace(); if (!workspace) return; workspace.setAttribute('aria-hidden', 'false'); state.visible = true; try { await loadGraphicsSettings(); await load(); state.resizeMap && state.resizeMap(); markOverlayDirty('open'); startSkyFrame(); resumeGraphAnimation(); loadLiveIntel(); loadWorldEvents(); startCombatStream(); syncSelectedCharacterFromShell(); await loadCharacterPositions(); startCharacterPositionTracking(); await loadIntelAlertSettings(); await loadRoutePreferences(); await startNewEdenMusic(); } catch (error) { document.getElementById('eve-map-canvas').innerHTML = `<div class="eve-map-status">${escapeHtml(error.message)}</div>`; } };
  window.closeEveMap = function () { const workspace = mapWorkspace(); workspace?.setAttribute('aria-hidden', 'true'); state.visible = false; stopNewEdenMusic(); stopCharacterPositionTracking(); stopCombatStream(); stopGateOverlay(); stopSkyFrame(); stopGraphAnimation(); };
  window.setEveMapOrigin = id => setEndpoint('origin', id);
  window.setEveMapDestination = id => setEndpoint('destination', id);
  window.setEveMapWaypoint = setEveMapWaypoint;
  window.sendEveMapRouteToEve = sendEveMapRouteToEve;
  window.traceEveMapRoute = traceRouteFromInputs;
  window.clearEveMapRoute = clearRoute;
  window.toggleEveMapPanelSection = togglePanelSection;
  window.toggleEveMapPanel = () => setPanelCollapsed(!state.panelCollapsed);
  window.openEveMapPanel = () => setPanelCollapsed(false);
  window.useEveMapSafeRoute = () => updateRoute(true);
  window.focusEveMapSystem = id => focus(systemFor(id));
  window.focusEveMapCharacter = id => focusCharacterPosition(id);
  window.clearEveMapCharacterSelection = clearCharacterSelection;
  window.setEveMapGraphicsQuality = applyGraphicsQuality;
  window.refreshEveMapCharacterPositions = () => loadCharacterPositions();
  window.showEveMapIntelAlert = showIntelAlertToast;
  window.__eveMapTest ||= {};
  if (window.__eveMapTest) {
    Object.assign(window.__eveMapTest, {
      clipSegmentToViewport, projectGateSegment, security, securityColor, characterColor, characterMarkerScale, systemObjectScale, combatMarkerGroups, combatActivity,
      estimateGateTraffic, estimateGateFlows, trafficStrength, trafficSize, trafficNodeStyle, trafficParticlePlan, trafficPacketOffsets, trafficParticleSpeed, trafficParticleProgress, trafficSegmentProgress, trafficParticleVisualStyle,
      shipIconUrl, formatKillDate, killLocation, panelKillLocation, systemHoverMarkup, areaHoverMarkup, staticSystemHoverMarkup, aggregateStaticIntel, gateHoverData, gateHoverMarkup, gateHoverCandidate, selectionSystems, aggregateLiveIntel, recentAreaKills, mergeKillRows, killRowsMarkup, panelSectionMarkup, selectionInfoMarkup, selectionIntelMarkup, isKillPopoverInteractionTarget, attackerPopoverMarkup,
       influenceOverlayRadius, influenceOverlayStyle, influenceLayers, cappedSystemObjectScale, systemScreenRadius, regionalViewPresence,
       nodeLod, spaceClass, updateNodeView, applyNodeGeometry, visibleNode, setMapFilter,
       tacticalSystemVisualCenter,tacticalSystemVisualRadius,drawTacticalSystemRing,drawDistantNodes,
       drawTacticalCombatLabel, tacticalAttachedLabel,
       setTacticalVisualTestMode:(flags={})=>{state.layoutMode='tactical';state.tactical2D=true;state.selectedSystemId=flags.selected?42:null;state.route=flags.route?{systems:[42]}:null;state.live.systems=flags.live?{'42':{danger:85}}:{};nodeView.key=null;},
       setSystemPreselection, drawSystemPreselection, setFlatCameraControls,
       jumpRouteSnapshot:()=>state.jumpRouteState, physicalJumpSnapshot:()=>physicalJumpView,
       nodeViewSnapshot: () => ({ ...state.perf, eligibleNodes: state.renderNodes.filter(visibleNode).length, totalNodes: state.renderNodes.length }),
      displayNodes, cameraPose, cameraFocusPosition, galaxyShot, visibleLabelGroup, labelsCanOverlap, mapLabelLayers, mapLabelPlacement, systemLabelOpacity, labelDistanceOpacity, intelLabelMetricValue, buildIntelLabelDistributions, intelLabelNormalizedIntensity, worldEventSummary, worldEventsForSystems, setWorldEventsForTest: (events, eventState = 'live') => { state.worldEvents = { events, state: eventState }; }, isAreaMember, focusNodeColor, gateVisualProfile, gateCameraFade, gateEmphasisKind, tacticalSystemIds, characterRingSegments, liveWithCombat, combatDangerScore, combatMarkerLabel, combatActivityForDanger, isPodMarker, characterPositionTrackingInterval, characterPositionSystemId, visibleCharacterIds, selectionReticleStyle, systemSelectionRadius, setMapZoomPreset,
       buildSkyStars, skyCameraKey, skyTextureDirection, worldSkyDirection, skyRayDirection, skyFieldDimensions, normalizeGraphicsQuality, graphicsProfile, currentGraphicsProfile, applyGraphicsQuality,
       nebulaColor, skyTextureCoordinates, skyTexturePacked, skyGpuFragmentShader: SKY_GPU_FRAGMENT_SHADER, stabilizeOrbitControls, projectSkyDirection, togglePanelSection, setPanelCollapsed, clearRoute, refreshMapHeader, overlayAnimationRequired, overlayPerfSnapshot: () => ({ ...state.perf, raf_active: Boolean(state.linkFrame), sky_raf_active: Boolean(state.skyFrame), dirty: [...state.overlayDirty] }), intelAlertMarkup, musicDuckMultiplier, musicDuckingPlan, musicVisibilityPlan, musicVolume,
       activeCharacters, activeCharacterSystemIds, mergeCombatMarkers, syncOverlayCamera, handleMapVisibilityChange, musicAutoStartEnabled: MUSIC_AUTOSTART_ENABLED
    });
  }
  function setMapFilter(key, checked) {
    if (!Object.prototype.hasOwnProperty.call(state.filters, key)) return;
    state.filters[key] = Boolean(checked);
    const input = document.querySelector?.(`[data-eve-security="${key}"]`) || document.getElementById(`eve-map-${key}`);
    if (input) input.checked = state.filters[key];
    if (key === 'sovereignty') {
      const indicator = document.getElementById('eve-map-sovereignty-state');
      if (state.filters[key]) loadSovereignty(); else if (indicator) indicator.textContent = 'off';
    }
    render(); refreshMapHeader();
  }
  async function toggleMapFullscreen() {
    const workspace = mapWorkspace(); if (!workspace) return false;
    try {
      if (document.fullscreenElement === workspace) await document.exitFullscreen?.();
      else await workspace.requestFullscreen?.();
      return true;
    } catch (_) { return false; }
  }
  function bindControls() {
    document.getElementById('eve-map-tactical-2d')?.addEventListener('change', event => {
      state.tactical2D = event.target.checked;
      if (state.layoutMode === 'tactical') setLayoutMode('tactical', state.tacticalCentre);
    });
    document.getElementById('eve-map-layout')?.addEventListener('change', event => setLayoutMode(event.target.checked ? 'tactical' : 'physical'));
    document.getElementById('eve-map-tactical-radius')?.addEventListener('input', event => {
      const value = Math.max(1, Math.min(5, Math.round(Number(event.target.value) || 3)));
      const text = value === 1 ? '1 jump' : value + ' jumps';
      event.target.setAttribute('aria-valuetext', text);
      const output = document.getElementById('eve-map-tactical-radius-value'); if (output) output.textContent = text;
    });
    document.getElementById('eve-map-tactical-radius')?.addEventListener('change', event => {
      state.tacticalRadius = Math.max(1, Math.min(5, Number(event.target.value) || 3));
      if (state.layoutMode === 'tactical') setLayoutMode('tactical', state.tacticalCentre);
    });
    document.querySelectorAll('[data-eve-security], #eve-map-gates, #eve-map-traffic, #eve-map-danger, #eve-map-sovereignty, #eve-map-empires').forEach(input => input.addEventListener('change', () => setMapFilter(input.dataset.eveSecurity || input.id.replace('eve-map-', ''), input.checked)));
    document.getElementById('eve-map-zoom-preset')?.addEventListener('input', event => setMapZoomPreset(event.target.value));
    document.getElementById('eve-map-search')?.addEventListener('input', event => { const query = event.target.value.trim().toLowerCase(); const box = document.getElementById('eve-map-results'); box.innerHTML = ''; if (!query || !state.data) return; state.data.systems.filter(s => s.name.toLowerCase().includes(query)).slice(0, 8).forEach(s => { const button = document.createElement('button'); button.textContent = `${s.name} · ${s.region}`; button.onclick = () => { box.innerHTML = ''; focus(s); }; box.appendChild(button); }); });
    document.getElementById('eve-map-route')?.addEventListener('click', traceRouteFromInputs);
    document.getElementById('eve-map-route-clear')?.addEventListener('click', clearRoute);
    document.getElementById('eve-map-panel-toggle')?.addEventListener('click', () => setPanelCollapsed(!state.panelCollapsed));
    document.getElementById('eve-map-hotspots')?.addEventListener('click', () => { state.showCombatHotspots = !state.showCombatHotspots; refreshMapHeader(); });
    document.getElementById('eve-map-intel-label-metric')?.addEventListener('change', event => { state.intelLabelMetric = event.target.value; rebuildIntelLabelValues(); render(); });
    document.getElementById('eve-map-world-events')?.addEventListener('click', event => { const filter = event.target?.dataset?.eveEventFilter; if (!filter) return; state.eventFilter = filter; renderWorldEventsPanel(); render(); });
    document.getElementById('eve-map-intel-alert-settings')?.addEventListener('change', event => {
      const input = event.target, key = input?.dataset?.eveIntelAlert;
      if (!key) return;
      const value = key === 'radius_jumps' ? Number(input.value) : Boolean(input.checked);
      saveIntelAlertSettings({ [key]: value });
    });
    document.getElementById('eve-map-fullscreen')?.addEventListener('click', toggleMapFullscreen);
    document.addEventListener?.('fullscreenchange', () => {
      const button = document.getElementById('eve-map-fullscreen'); if (!button) return;
      const expanded = document.fullscreenElement === mapWorkspace(); button.textContent = '⛶'; button.title = expanded ? 'Exit fullscreen map' : 'Enter fullscreen map'; button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(expanded));
    });
    document.addEventListener?.('visibilitychange', () => handleMapVisibilityChange(document.visibilityState !== 'hidden'));
    window.addEventListener?.('focus', () => handleMapVisibilityChange(document.visibilityState !== 'hidden'));
    refreshMapHeader();
    document.addEventListener?.('pointerdown', event => {
      const target = event.target, popover = state.killPopover;
      if (!popover || popover.style.display === 'none') return;
      if (isKillPopoverInteractionTarget(target, popover)) return;
      closeKillPopover();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindControls);
  else bindControls();
}());
