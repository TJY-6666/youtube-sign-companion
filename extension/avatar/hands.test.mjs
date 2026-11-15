import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as T from './vendor/three.module.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { createHand } from './hands.js';
import { JOINTS, ARM_SIDES, sourceBodyAxis } from './motion.js';

async function build(side = -1) {
  const data = await readFile(new URL(`./assets/${side > 0 ? 'left' : 'right'}.glb`, import.meta.url));
  const model = (await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '')).scene;
  const wrist = new T.Group(), joints = new Map(), name = side > 0 ? 'L' : 'R';
  const hand = createHand({ model, name, side, wrist, joints, material: new T.MeshStandardMaterial(), layer: 1 });
  return { ...hand, wrist, joints, name };
}
function curlFrame(value = 1) {
  const frame = Array(133).fill(0);
  for (const name of JOINTS) if (/_(Index|Middle|Ring|Pinky)[123]$/.test(name)) frame[JOINTS.indexOf(name) * 3 + 2] = name.startsWith('L_') ? -value : value;
  return frame;
}

test('captured hand landmarks retain palm orientation and all finger segment directions on both hands', async () => {
  for (const side of [-1, 1]) {
    const hand = await build(side);
    hand.wrist.rotation.set(.35, -.4, .25); hand.applyPose(curlFrame(.7)); hand.wrist.updateWorldMatrix(true, true);
    const byName = new Map(hand.bones.map(bone => [bone.name, bone]));
    const prefixes = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
    const names = ['wrist', ...prefixes.flatMap(prefix => prefix === 'thumb' ? ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'].map(suffix => `${prefix}-${suffix}`) : ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map(suffix => `${prefix}-${suffix}`))];
    const observed = names.map(name => byName.get(name).getWorldPosition(new T.Vector3()).toArray());
    const lengths = hand.bones.map(bone => bone.position.length());
    const expected = [];
    for (const start of [1, 5, 9, 13, 17]) for (let j = 0; j < 3; j++) expected.push(new T.Vector3(...observed[start + j + 1]).sub(new T.Vector3(...observed[start + j])).normalize());
    hand.wrist.quaternion.identity(); hand.applyPose(Array(133).fill(0)); hand.applyLandmarks(observed);
    const actual = names.map(name => byName.get(name).getWorldPosition(new T.Vector3()));
    let count = 0;
    for (const start of [1, 5, 9, 13, 17]) for (let j = 0; j < 3; j++) assert.ok(actual[start + j + 1].clone().sub(actual[start + j]).normalize().distanceTo(expected[count++]) < 1e-6);
    hand.bones.forEach((bone, i) => assert.ok(Math.abs(bone.position.length() - lengths[i]) < 1e-8));
    hand.applyLandmarks(null); assert.equal(hand.mesh.visible, true);
    for (const control of hand.controls) assert.deepEqual(control.bone.quaternion.toArray(), control.rest.toArray());
    hand.applyPose(Array(133).fill(0)); assert.equal(hand.mesh.visible, true);
  }
});

test('body rotations preserve the checked SMPL-X basis for both shoulders and elbows', () => {
  for (const side of [-1, 1]) {
    for (const [axis, expected] of [
      [[0, 0, -side * Math.PI / 2], new T.Vector3(0, -1, 0)],
      [[0, -side * Math.PI / 2, 0], new T.Vector3(0, 0, 1)],
    ]) {
      const rotation = sourceBodyAxis(axis, 0, new T.Vector3()), angle = rotation.length();
      const quaternion = new T.Quaternion().setFromAxisAngle(rotation.normalize(), angle);
      assert.ok(new T.Vector3(side, 0, 0).applyQuaternion(quaternion).distanceTo(expected) < 1e-8);
    }
  }
});

test('front-facing left/right assets point outward with thumbs toward the front and curls on the actual palm side', async () => {
  assert.deepEqual(ARM_SIDES, [['L', 1], ['R', -1]]);
  for (const [name, side] of ARM_SIDES) {
    const hand = await build(side), origin = hand.bones.find(b => b.name === 'wrist').getWorldPosition(new T.Vector3());
    const finger = hand.tips[1].getWorldPosition(new T.Vector3()).sub(origin);
    const across = hand.tips[0].getWorldPosition(new T.Vector3()).sub(hand.tips[3].getWorldPosition(new T.Vector3()));
    const palm = new T.Vector3().crossVectors(finger, across).multiplyScalar(name === 'L' ? 1 : -1).normalize();
    assert.ok(finger.x * side > .15, `${name} fingers point away from the body.`);
    assert.ok(palm.y < -.85, `${name} actual palm faces down in the T pose.`);
    assert.ok(hand.tips[4].getWorldPosition(new T.Vector3()).z > .05, 'Thumbs point toward the front of the body.');
  }
});

test('original connected hand assets retain all 25 joints, inverse bind matrices and normalized skin weights', async () => {
  for (const side of [-1, 1]) {
    const hand = await build(side), geometry = hand.mesh.geometry;
    assert.equal(hand.bones.length, 25); assert.equal(hand.controls.length, 15); assert.equal(hand.tips.length, 5);
    for (const name of JOINTS.filter(name => name.startsWith(hand.name + '_') && /[123]$/.test(name))) assert.ok(hand.joints.has(name), name);
    const positions = geometry.getAttribute('position'), weights = geometry.getAttribute('skinWeight');
    assert.ok(positions.count < 2000); assert.equal(hand.mesh.skeleton.boneInverses.length, 25);
    for (let i = 0; i < positions.count; i++) {
      let total = 0;
      for (let j = 0; j < 4; j++) { const w = weights.array[i * 4 + j]; assert.ok(w >= 0 && w <= 1); total += w; }
      assert.ok(Math.abs(total - 1) < 1e-4);
    }
    // A rigid wrist/alignment change must not disturb the mesh's original bind pose.
    hand.wrist.position.set(.4, 1.2, -.2); hand.wrist.rotation.set(.3, -.2, .1); hand.wrist.updateMatrixWorld(true);
    for (let i = 0; i < positions.count; i += 17) {
      const p = new T.Vector3().fromBufferAttribute(positions, i), original = p.clone(); hand.mesh.applyBoneTransform(i, p);
      assert.ok(p.distanceTo(original) < 1e-5);
    }
  }
});

test('source-oriented left/right curls bend palmward without stretching any finger bone', async () => {
  for (const side of [-1, 1]) {
    const hand = await build(side), rest = Array(133).fill(0);
    const lengths = hand.bones.map(b => b.position.length()), before = hand.tips.slice(0, 4).map(b => b.getWorldPosition(new T.Vector3()));
    hand.applyPose(curlFrame(.8)); hand.wrist.updateMatrixWorld(true);
    for (const [i, tip] of hand.tips.slice(0, 4).entries()) assert.ok(tip.getWorldPosition(new T.Vector3()).y < before[i].y - .025, `${hand.name} finger ${i} must curl palmward.`);
    for (const [i, bone] of hand.bones.entries()) assert.ok(Math.abs(bone.position.length() - lengths[i]) < 1e-9);
    hand.applyPose(rest); hand.wrist.updateMatrixWorld(true);
    for (const [i, tip] of hand.tips.slice(0, 4).entries()) assert.ok(tip.getWorldPosition(new T.Vector3()).distanceTo(before[i]) < 1e-7);
  }
});

test('all source axes and their signs survive, including distal joints; other fingers remain independent', async () => {
  const hand = await build(), rest = Array(133).fill(0), frame = rest.slice();
  const middle = hand.tips[1].getWorldPosition(new T.Vector3());
  const index2 = JOINTS.indexOf('R_Index2') * 3, thumb1 = JOINTS.indexOf('R_Thumb1') * 3;
  frame[index2] = .4; frame[index2 + 1] = -.6;
  hand.applyPose(frame);
  const distal = hand.controls.find(c => c.bone === hand.joints.get('R_Index2'));
  assert.ok(distal.bone.quaternion.angleTo(distal.rest) > .5, 'Source x/y rotation must not be discarded.');
  hand.wrist.updateMatrixWorld(true);
  const positiveTip = hand.tips[0].getWorldPosition(new T.Vector3());
  frame[index2] *= -1; frame[index2 + 1] *= -1;
  hand.applyPose(frame); hand.wrist.updateMatrixWorld(true);
  assert.ok(hand.tips[0].getWorldPosition(new T.Vector3()).distanceTo(positiveTip) > .01, 'Negative rotation must not become the same motion.');
  frame[thumb1] = -1; frame[thumb1 + 2] = .8;
  const thumbBefore = hand.tips[4].getWorldPosition(new T.Vector3());
  hand.applyPose(frame); hand.wrist.updateMatrixWorld(true);
  assert.ok(hand.tips[4].getWorldPosition(new T.Vector3()).distanceTo(thumbBefore) > .01);
  assert.ok(hand.tips[1].getWorldPosition(new T.Vector3()).distanceTo(middle) < 1e-7);
});

test('source rotation chains preserve world-frame deltas on both hands with a rotated wrist', async () => {
  for (const side of [-1, 1]) {
    const hand = await build(side), frame = Array(133).fill(0);
    const restWorld = hand.controls.map(control => control.bone.getWorldQuaternion(new T.Quaternion()));
    hand.controls.forEach((control, index) => { frame[control.offset] = .25; frame[control.offset + 1] = -.1 * (index % 3 + 1); frame[control.offset + 2] = side * .4; });
    hand.wrist.rotation.set(.3, -.2, .4); hand.applyPose(frame); hand.wrist.updateMatrixWorld(true);
    let source = new T.Quaternion();
    for (const [index, control] of hand.controls.entries()) {
      if (control.index === 0) source.identity();
      const axis = new T.Vector3(...frame.slice(control.offset, control.offset + 3)), angle = axis.length();
      source.multiply(new T.Quaternion().setFromAxisAngle(axis.normalize(), angle));
      const expected = hand.wrist.quaternion.clone().multiply(source).multiply(restWorld[index]);
      assert.ok(expected.normalize().angleTo(control.bone.getWorldQuaternion(new T.Quaternion()).normalize()) < 1e-7);
    }
  }
});

test('extreme valid input stays bounded and interpolated skin vertices remain finite', async () => {
  const hand = await build(), frame = Array(133).fill(100), positions = hand.mesh.geometry.getAttribute('position');
  hand.applyPose(frame, curlFrame(), .5); hand.wrist.updateMatrixWorld(true);
  for (let i = 0; i < positions.count; i += 11) {
    const p = new T.Vector3().fromBufferAttribute(positions, i); hand.mesh.applyBoneTransform(i, p);
    assert.ok([p.x, p.y, p.z].every(Number.isFinite)); assert.ok(p.length() < .5);
  }
  assert.ok(!hand.updateBounds().isEmpty());
});
