import * as T from './vendor/three.module.js';
import { JOINTS } from './motion.js';
import { directionFrame } from './landmarks.js';

const fingers = { Index: 'index-finger', Middle: 'middle-finger', Ring: 'ring-finger', Pinky: 'pinky-finger', Thumb: 'thumb' };
const phalanges = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'];
// Retain source rotations; the target mesh still has different proportions and skin weights.
export function createHand({ model, name, side, wrist, joints, material, layer }) {
  const mesh = model.getObjectByProperty('isSkinnedMesh', true);
  if (!mesh || mesh.skeleton.bones.length !== 25) throw new Error('Hand asset must have its original 25-joint skin.');
  const nodes = new Map(mesh.skeleton.bones.map(node => [node.name, node]));
  const root = nodes.get('wrist'), tips = [], controls = [];
  if (!root) throw new Error('Hand asset wrist is missing.');
  model.updateWorldMatrix(true, true);
  const wristOrigin = root.getWorldPosition(new T.Vector3());
  for (const [finger, prefix] of Object.entries(fingers)) {
    const names = finger === 'Thumb' ? ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'] : ['metacarpal', ...phalanges, 'tip'];
    let parent = root;
    for (const suffix of names) {
      const bone = nodes.get(`${prefix}-${suffix}`);
      if (!bone) throw new Error(`Hand asset joint is missing: ${prefix}-${suffix}`);
      parent.attach(bone); parent = bone;
    }
    tips.push(parent);
  }
  // T pose: fingertips point outward, palms down, thumbs toward the face's front (+Z).
  const alignment = new T.Group(); alignment.rotation.set(Math.PI, 0, -side * Math.PI / 2, 'ZXY');
  model.position.sub(wristOrigin); alignment.add(model); wrist.add(alignment);
  model.traverse(node => { node.layers.set(layer); });
  mesh.material = material; mesh.frustumCulled = false;
  wrist.updateWorldMatrix(true, true);
  const wristInverse = wrist.getWorldQuaternion(new T.Quaternion()).invert();
  const position = new T.Vector3();
  for (const [finger, prefix] of Object.entries(fingers)) {
    const suffixes = finger === 'Thumb' ? ['metacarpal', 'phalanx-proximal', 'phalanx-distal'] : phalanges;
    suffixes.forEach((suffix, index) => {
      const bone = nodes.get(`${prefix}-${suffix}`);
      controls.push({ bone, finger, index, offset: JOINTS.indexOf(`${name}_${finger}${index + 1}`) * 3,
        rest: bone.quaternion.clone(),
        parentFrameInverse: wristInverse.clone().multiply(bone.parent.getWorldQuaternion(new T.Quaternion())).normalize().invert(),
        restFrame: wristInverse.clone().multiply(bone.getWorldQuaternion(new T.Quaternion())).normalize() });
      joints.set(`${name}_${finger}${index + 1}`, bone);
    });
  }
  const point = node => node.getWorldPosition(new T.Vector3());
  const across = point(joints.get(`${name}_Index1`)).sub(point(joints.get(`${name}_Pinky1`)));
  const along = point(joints.get(`${name}_Middle1`)).sub(point(root));
  const palmBindInverse = directionFrame(across, along).invert();
  const wristBind = wrist.getWorldQuaternion(new T.Quaternion());
  const trackingIndices = { Thumb: 1, Index: 5, Middle: 9, Ring: 13, Pinky: 17 };
  for (const control of controls) {
    const next = control.bone.children.find(node => node.isBone);
    if (!next) throw new Error('Hand tracking requires each phalanx tip.');
    control.trackingIndex = trackingIndices[control.finger] + control.index;
    control.trackingBindInverse = directionFrame(control.finger === 'Thumb' ? along : across, point(next).sub(point(control.bone))).invert();
    control.trackingBindWorld = control.bone.getWorldQuaternion(new T.Quaternion());
  }
  const aRotation = new T.Quaternion(), bRotation = new T.Quaternion(), axis = new T.Vector3();
  function retarget(control, frame, target) {
    const offset = control.offset;
    axis.set(frame[offset], frame[offset + 1], frame[offset + 2]);
    const angle = axis.length();
    if (angle < 1e-8) target.identity(); else target.setFromAxisAngle(axis.divideScalar(angle), angle);
    return target.premultiply(control.parentFrameInverse).multiply(control.restFrame).normalize();
  }
  const bounds = new T.Box3(), landmarks = mesh.skeleton.bones;
  return { mesh, bones: mesh.skeleton.bones, tips, controls, alignment, bounds,
    applyLandmarks(points) {
      mesh.visible = true;
      if (!points) {
        wrist.quaternion.identity();
        for (const control of controls) control.bone.quaternion.copy(control.rest);
        wrist.updateWorldMatrix(true, true); return;
      }
      const observed = points.map(value => new T.Vector3(...value));
      const acrossNow = observed[5].clone().sub(observed[17]);
      const alongNow = observed[9].clone().sub(observed[0]);
      const palmNow = directionFrame(acrossNow, alongNow);
      const target = palmNow.multiply(palmBindInverse).multiply(wristBind);
      const parentRotation = wrist.parent ? wrist.parent.getWorldQuaternion(new T.Quaternion()) : new T.Quaternion();
      wrist.quaternion.copy(parentRotation.invert().multiply(target));
      wrist.updateWorldMatrix(true, true);
      for (const control of controls) {
        const index = control.trackingIndex;
        const desired = directionFrame(control.finger === 'Thumb' ? alongNow : acrossNow, observed[index + 1].clone().sub(observed[index])).multiply(control.trackingBindInverse).multiply(control.trackingBindWorld);
        control.bone.quaternion.copy(control.bone.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(desired));
        control.bone.updateWorldMatrix(true, true);
      }
    },
    applyPose(a, b = a, mix = 0) {
      mesh.visible = true;
      for (const control of controls) {
        retarget(control, a, aRotation); retarget(control, b, bRotation);
        control.bone.quaternion.copy(aRotation.slerp(bRotation, mix));
      }
    },
    updateBounds() {
      bounds.makeEmpty();
      for (const node of landmarks) bounds.expandByPoint(node.getWorldPosition(position));
      return bounds.expandByScalar(.018);
    },
  };
}
