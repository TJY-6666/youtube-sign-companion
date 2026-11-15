import * as T from './vendor/three.module.js';
import { JOINTS, ARM_SIDES, sourceBodyAxis, validateMotion } from './motion.js';
import { createHand } from './hands.js';
import { validateLandmarks, applyBodyLandmarks, blendLandmarks } from './landmarks.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
const canvas = document.querySelector('canvas'), label = document.querySelector('#label');
const tell = value => parent.postMessage({ type: 'companion.avatar', ...value }, parent === window ? location.origin : '*');
try {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.autoClear = false;
  const scene = new T.Scene();
  const background = new T.Color('#303636'), detailBackground = new T.Color('#242828');
  let dirty = true;
  const camera = new T.PerspectiveCamera(33, 1, 0.01, 20); camera.position.set(0, 1.27, 2.65); camera.lookAt(0, 1.27, 0);
  camera.layers.enable(1); camera.layers.enable(2);
  const fill = new T.HemisphereLight(0xffffff, 0x747d7d, 1.8); scene.add(fill);
  const light = new T.DirectionalLight(0xffffff, 2.5); light.position.set(-2, 4, 4); scene.add(light);
  for (const source of [fill, light]) { source.layers.enable(1); source.layers.enable(2); }
  const skin = new T.MeshStandardMaterial({ color: '#dba77d', roughness: 0.85 });
  const shirt = new T.MeshStandardMaterial({ color: '#17675f', roughness: 1 });
  const hair = new T.MeshStandardMaterial({ color: '#29241f', roughness: 1 });
  const white = new T.MeshStandardMaterial({ color: '#f5f1e9' }), ink = new T.MeshStandardMaterial({ color: '#242120' });
  const figure = new T.Group(); scene.add(figure); const joints = new Map();
  const hands = [];
  const handLoader = new GLTFLoader();
  const joint = (name, parentJoint, x, y, z = 0) => {
    const node = new T.Group(); node.position.set(x, y, z); parentJoint.add(node); joints.set(name, node); return node;
  };
  function ellipsoid(parentJoint, material, x, y, z, sx, sy, sz) {
    const mesh = new T.Mesh(new T.SphereGeometry(1, 20, 14), material); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); parentJoint.add(mesh); return mesh;
  }
  function limb(node, length, side, radius, material) {
    const mesh = new T.Mesh(new T.CapsuleGeometry(radius, Math.max(0, length - radius * 2), 4, 10), material);
    mesh.rotation.z = -Math.PI / 2; mesh.position.x = side * length / 2; node.add(mesh);
  }
  const torso = new T.Mesh(new T.LatheGeometry([[0.18, 0.58], [0.19, 0.65], [0.21, 0.94], [0.26, 1.20], [0.23, 1.29], [0.10, 1.36]].map(([x, y]) => new T.Vector2(x, y)), 24), shirt);
  torso.scale.z = 0.6; figure.add(torso);
  const neck = joint('Neck', figure, 0, 1.36); ellipsoid(neck, skin, 0, 0.025, 0, 0.065, 0.105, 0.065);
  const head = joint('Head', neck, 0, 0.16);
  ellipsoid(head, skin, 0, 0.08, 0, 0.142, 0.187, 0.13);
  ellipsoid(head, hair, 0, 0.20, -0.018, 0.146, 0.086, 0.13);
  ellipsoid(head, skin, 0, 0.065, 0.128, 0.025, 0.035, 0.027);
  for (const side of [-1, 1]) {
    ellipsoid(head, skin, side * 0.143, 0.077, 0, 0.024, 0.045, 0.025);
    ellipsoid(head, white, side * 0.053, 0.113, 0.117, 0.033, 0.022, 0.014);
    ellipsoid(head, ink, side * 0.053, 0.113, 0.131, 0.012, 0.015, 0.006);
    ellipsoid(head, hair, side * 0.052, 0.151, 0.114, 0.035, 0.008, 0.008);
  }
  const jaw = joint('Jaw', head, 0, 0.025, 0.10); ellipsoid(jaw, ink, 0, 0, 0.023, 0.035, 0.006, 0.006);
  // Initial display basis for the released motion. Full bind-pose calibration is pending.
  for (const [name, side] of ARM_SIDES) {
    ellipsoid(figure, shirt, side * 0.19, 1.27, 0, 0.085, 0.075, 0.075);
    const collar = joint(`${name}_Collar`, figure, side * 0.065, 1.30);
    const shoulder = joint(`${name}_Shoulder`, collar, side * 0.16, 0); limb(shoulder, 0.28, side, 0.055, shirt);
    const elbow = joint(`${name}_Elbow`, shoulder, side * 0.28, 0); limb(elbow, 0.25, side, 0.039, skin);
    const wrist = joint(`${name}_Wrist`, elbow, side * 0.25, 0);
    const layer = hands.length + 1;
    const model = (await handLoader.loadAsync(new URL(`./assets/${name === 'L' ? 'left' : 'right'}.glb`, import.meta.url).href)).scene;
    const hand = createHand({ model, name, side, wrist, joints, material: skin, layer });
    hand.camera = new T.OrthographicCamera(-.15, .15, .15, -.15, .01, 5); hand.camera.layers.set(layer); hands.push(hand);
  }
  const detailButton = document.querySelector('#hand-detail'), detailLabels = document.querySelector('#hand-labels');
  let showDetails = true, width = 1, height = 1;
  detailButton.onclick = () => {
    showDetails = !showDetails; detailButton.setAttribute('aria-pressed', String(showDetails)); detailLabels.hidden = !showDetails; dirty = true;
    detailButton.textContent = showDetails ? '收起手部特写' : '显示手部特写';
  };
  const center = new T.Vector3(), extent = new T.Vector3();
  function draw() {
    const detailHeight = showDetails ? Math.round(height * .32) : 0, mainHeight = height - detailHeight;
    renderer.setScissorTest(true);
    renderer.setViewport(0, detailHeight, width, mainHeight); renderer.setScissor(0, detailHeight, width, mainHeight);
    renderer.setClearColor(background); renderer.clear();
    camera.aspect = width / mainHeight; camera.updateProjectionMatrix(); renderer.render(scene, camera);
    if (showDetails) hands.forEach((hand, index) => {
      const pane = 1 - index; // Front view: the signer's right hand is on the viewer's left.
      const x = Math.floor(width * pane / 2), paneWidth = Math.floor(width * (pane + 1) / 2) - x;
      hand.updateBounds().getCenter(center); hand.bounds.getSize(extent);
      const aspect = paneWidth / detailHeight, span = Math.max(.22, extent.y, extent.x / aspect) * 1.12;
      const close = hand.camera; close.left = -span * aspect / 2; close.right = -close.left; close.top = span / 2; close.bottom = -close.top;
      close.position.copy(center); close.position.z += 2; close.lookAt(center); close.updateProjectionMatrix();
      renderer.setViewport(x, 0, paneWidth, detailHeight); renderer.setScissor(x, 0, paneWidth, detailHeight);
      renderer.setClearColor(detailBackground); renderer.clear(); renderer.render(scene, close);
    });
    renderer.setScissorTest(false);
  }
  const qa = new T.Quaternion(), qb = new T.Quaternion(), axis = new T.Vector3();
  function rotation(frame, offset, quaternion) {
    sourceBodyAxis(frame, offset, axis); const angle = axis.length();
    return angle < 1e-8 ? quaternion.identity() : quaternion.setFromAxisAngle(axis.divideScalar(angle), angle);
  }
  function pose(a, b = a, mix = 0) {
    if (a.selected === false) { pose(rest); setLabel('Demo idle · no selected sign at this time'); return; }
    if (a.pose) {
      const frame = blendLandmarks(a, b, mix);
      for (const name of ['Neck', 'Head', 'L_Collar', 'R_Collar', 'Jaw']) joints.get(name).quaternion.identity();
      applyBodyLandmarks(joints, frame);
      hands[0].applyLandmarks(frame.left); hands[1].applyLandmarks(frame.right);
      setLabel(clip?.phraseLabel ? `Stored ${clip.phraseLabel} · ASL unreviewed` : !frame.left || !frame.right ? 'Prerecorded teacher motion · untracked hand at rest' : 'Prerecorded teacher motion · retargeting unreviewed');
      dirty = true; return;
    }
    JOINTS.forEach((name, index) => { const node = joints.get(name); if (node && (index < 10 || index === 40)) node.quaternion.copy(rotation(a, index * 3, qa)).slerp(rotation(b, index * 3, qb), mix); });
    for (const hand of hands) hand.applyPose(a, b, mix);
    dirty = true;
    // Expression coefficients are preserved in motion133, but require a compatible face model.
    // Do not invent a semantic mapping for the ten SMPL-X expression coefficients.
  }
  // Only the backend's isolated loopback renderer exports synthetic rig images.
  if (new URLSearchParams(location.search).get('export') === '1' && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
    window.captureCompanionFrames = value => {
      validateMotion(value);
      if (value.handPose !== 'smplx-absolute') throw new Error('Hand calibration is missing. Update the backend before rendering.');
      const frames = [], count = Math.ceil(value.frames.length / value.fps * 12);
      if (count > 240) throw new Error('Too many source frames.');
      renderer.setPixelRatio(1); renderer.setSize(384, 384, false); camera.aspect = 1; camera.updateProjectionMatrix();
      renderer.setScissorTest(false); renderer.setViewport(0, 0, 384, 384); renderer.setClearColor(background);
      for (let i = 0; i < count; i++) {
        const t = Math.min(value.frames.length - 1, i * value.fps / 12), index = Math.floor(t);
        pose(value.frames[index], value.frames[Math.min(index + 1, value.frames.length - 1)], t % 1);
        renderer.clear(); renderer.render(scene, camera);
        frames.push(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
      }
      return frames;
    };
  }
  const rest = Array(133).fill(0); rest[14] = -1.1; rest[17] = 1.1; rest[19] = -0.30; rest[22] = 0.30; pose(rest);
  let clip = null, frameTime = 0, paused = false, playing = false, externalClock = false, previous = performance.now(), serial = null, lastPaint = 0;
  function setLabel(text) {
    const names = {
      'Avatar rig preview · no motion loaded': 'Avatar 待机 · 请在上方开始翻译',
      'Demo idle · no selected sign at this time': '等待下一段固定示范',
      'Prerecorded teacher motion · retargeting unreviewed': '预录示范 · 动作适配尚未核验',
      'Prerecorded teacher motion · untracked hand at rest': '预录示范 · 未跟踪到的手部暂时待机',
      'Rig calibration · not sign language': '骨架校准 · 不是手语',
      'Pose correction test · ASL unverified': '姿态实验 · 手语含义未核验',
      'Experimental rig · mapping unverified': '实验动作 · 骨架适配未核验',
    };
    label.textContent = text.startsWith('Stored ') ? `预制短语：${text.slice(7).split(' · ')[0]} · 未核验` : names[text] || text;
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.target !== 'companion.avatar') return;
    const message = event.data;
    try {
      if (message.action === 'load') {
        if (message.clip?.format === 'landmarks-v1') validateLandmarks(message.clip); else validateMotion(message.clip);
        if (message.clip.format !== 'landmarks-v1' && !message.calibration && message.clip.handPose !== 'smplx-absolute') throw new Error('Hand calibration is missing. Update the backend and reload the page.');
        clip = message.clip; serial = message.serial; frameTime = 0; externalClock = Boolean(message.externalClock); playing = !externalClock; paused = false;
        if (externalClock) pose(clip.frames[0]);
        setLabel(clip.phraseLabel ? `Stored ${clip.phraseLabel} · ASL unreviewed` : clip.format === 'landmarks-v1' ? 'Prerecorded teacher motion · retargeting unreviewed' : message.calibration ? 'Rig calibration · not sign language' : clip.poseProfile === 'experimental-inverse' ? 'Pose correction test · ASL unverified' : 'Experimental rig · mapping unverified'); tell({ loaded: serial });
      }
      if (message.action === 'pause') paused = true;
      if (message.action === 'resume') paused = false;
      if (message.action === 'sync' && clip && externalClock && Number.isFinite(message.progress)) {
        const next = T.MathUtils.clamp(message.progress, 0, 1) * (clip.frames.length - 1);
        if (Math.abs(next - frameTime) > .001) {
          frameTime = next; const index = Math.floor(next);
          pose(clip.frames[index], clip.frames[Math.min(index + 1, clip.frames.length - 1)], next % 1);
        }
      }
      if (message.action === 'reset') { clip = null; playing = false; pose(rest); setLabel(message.demoGap ? 'Demo idle · no selected sign at this time' : 'Avatar rig preview · no motion loaded'); }
      if (message.action === 'replay' && clip) { frameTime = 0; externalClock = false; playing = true; paused = false; }
    } catch (e) { tell({ error: e.message }); }
  });
  function paint(now) {
    requestAnimationFrame(paint);
    const elapsed = Math.min((now - previous) / 1000, 0.1); previous = now;
    if (clip && playing && !paused) {
      frameTime += elapsed * clip.fps;
      const index = Math.min(clip.frames.length - 1, Math.floor(frameTime));
      pose(clip.frames[index], clip.frames[Math.min(index + 1, clip.frames.length - 1)], frameTime % 1);
      if (frameTime >= clip.frames.length) { playing = false; tell({ ended: serial }); }
    }
    if (!dirty || now - lastPaint < 1000 / 30) return;
    lastPaint = now; draw(); dirty = false;
  }
  new ResizeObserver(() => {
    width = canvas.clientWidth; height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false); dirty = true;
  }).observe(canvas);
  setLabel('Avatar rig preview · no motion loaded'); tell({ ready: true }); requestAnimationFrame(paint);
} catch (error) { label.textContent = '3D 显示失败，请刷新页面并检查 WebGL 支持。'; tell({ error: error.message }); }
