/* gl.js — the bits app.js and viewer.js both need: 4x4 maths, the GLB reader
 * for the indexed normal-free files cad/export_web.py writes, and the shader
 * that reconstructs flat normals from derivatives. */

export const M4 = {
  id: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  trans(x, y, z) { const m = M4.id(); m[12]=x; m[13]=y; m[14]=z; return m; },
  rotX(d) {
    const a = d*Math.PI/180, c = Math.cos(a), s = Math.sin(a), m = M4.id();
    m[5]=c; m[6]=s; m[9]=-s; m[10]=c; return m;
  },
  persp(fovy, asp, n, f) {
    const t = 1/Math.tan(fovy/2), m = new Float32Array(16);
    m[0]=t/asp; m[5]=t; m[10]=(f+n)/(n-f); m[11]=-1; m[14]=2*f*n/(n-f);
    return m;
  },
  look(eye, tgt, up) {
    const sub = (a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
    const nrm = v => { const l = Math.hypot(...v)||1; return [v[0]/l,v[1]/l,v[2]/l]; };
    const cr = (a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    const z = nrm(sub(eye,tgt)), x = nrm(cr(up,z)), y = cr(z,x);
    return new Float32Array([
      x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
      -(x[0]*eye[0]+x[1]*eye[1]+x[2]*eye[2]),
      -(y[0]*eye[0]+y[1]*eye[1]+y[2]*eye[2]),
      -(z[0]*eye[0]+z[1]*eye[1]+z[2]*eye[2]), 1]);
  },
};

export async function loadGLB(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  const buf = await res.arrayBuffer(), dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error("not a GLB");
  let off = 12, json = null, bin = null;
  while (off + 8 <= dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const body = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004E4942) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  const acc = i => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView];
    const o = v.byteOffset || 0, n = a.type === "VEC3" ? 3 : 1;
    if (a.componentType === 5126) return new Float32Array(bin, o, a.count * n);
    if (a.componentType === 5123) return new Uint16Array(bin, o, a.count);
    return new Uint32Array(bin, o, a.count);
  };
  return json.nodes.map(nd => {
    const p = json.meshes[nd.mesh].primitives[0];
    const c = json.materials[p.material].pbrMetallicRoughness.baseColorFactor;
    return { name: nd.name, pos: acc(p.attributes.POSITION),
             idx: acc(p.indices), color: [c[0], c[1], c[2]] };
  });
}

const VS = `#version 300 es
in vec3 p; uniform mat4 mvp, mv; out vec3 vp;
void main(){ vp = (mv * vec4(p,1.)).xyz; gl_Position = mvp * vec4(p,1.); }`;

const FS = `#version 300 es
precision highp float;
in vec3 vp; uniform vec3 col; out vec4 o;
void main(){
  vec3 n = normalize(cross(dFdx(vp), dFdy(vp)));
  float key  = max(dot(n, normalize(vec3(0.45, 0.55, 0.85))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.35))), 0.0);
  float rim  = pow(1.0 - max(dot(n, vec3(0,0,1)), 0.0), 2.5);
  vec3 c = col * (0.22 + 0.86*key + 0.26*fill) + vec3(0.30,0.20,0.55)*rim*0.55;
  o = vec4(pow(c, vec3(1.0/2.2)), 1.0);
}`;

export function makeGL(cv) {
  const gl = cv.getContext("webgl2", { antialias: true, alpha: false });
  if (!gl) throw new Error("this browser has no WebGL2");
  const sh = (t, src) => {
    const s = gl.createShader(t);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.enable(gl.DEPTH_TEST);
  return { gl, prog, U: {
    mvp: gl.getUniformLocation(prog, "mvp"),
    mv:  gl.getUniformLocation(prog, "mv"),
    col: gl.getUniformLocation(prog, "col"),
  }};
}
