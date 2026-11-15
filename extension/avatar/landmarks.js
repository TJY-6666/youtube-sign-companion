import * as T from './vendor/three.module.js';

const vector = point => new T.Vector3(...point);
export function directionFrame(across, along) {
  if (along.lengthSq() < 1e-10) return new T.Quaternion();
  const y = along.clone().normalize();
  let x = across.clone().addScaledVector(y, -across.dot(y));
  if (x.lengthSq() < 1e-10) {
    x = Math.abs(y.z) < .8 ? new T.Vector3(0, 0, 1) : new T.Vector3(1, 0, 0);
    x.addScaledVector(y, -x.dot(y));
  }
  x.normalize();
  return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x, y, x.clone().cross(y).normalize()));
}
export function validateLandmarks(clip) {
  const points = (value, count) => Array.isArray(value) && value.length === count && value.every(point => Array.isArray(point) && point.length === 3 && point.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10));
  if (clip?.format !== 'landmarks-v1' || clip.fps !== 20 || !Array.isArray(clip.frames) || clip.frames.length < 2 || clip.frames.length > 301 || clip.frames.some(frame => !points(frame.pose, 6) || frame.left !== null && !points(frame.left, 21) || frame.right !== null && !points(frame.right, 21))) throw new Error('Invalid prerecorded landmark track.');
  return clip;
}
export function applyBodyLandmarks(joints, frame) {
  for (const [name, side, shoulderIndex, elbowIndex, wristIndex] of [['L', 1, 0, 2, 4], ['R', -1, 1, 3, 5]]) {
    for (const [jointName, start, end] of [['Shoulder', shoulderIndex, elbowIndex], ['Elbow', elbowIndex, wristIndex]]) {
      const node = joints.get(`${name}_${jointName}`), delta = vector(frame.pose[end]).sub(vector(frame.pose[start]));
      if (delta.lengthSq() < 1e-8) continue;
      const target = new T.Quaternion().setFromUnitVectors(new T.Vector3(side, 0, 0), delta.normalize());
      node.quaternion.copy(node.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(target));
      node.updateWorldMatrix(true, true);
    }
  }
}
export function blendLandmarks(a, b, mix) {
  const blend = (first, second) => !first || !second ? (mix < .5 ? first : second) : first.map((point, i) => point.map((value, axis) => value + (second[i][axis] - value) * mix));
  return { pose: blend(a.pose, b.pose), left: blend(a.left, b.left), right: blend(a.right, b.right) };
}
