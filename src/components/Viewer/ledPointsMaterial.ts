import * as THREE from 'three';

// Custom ShaderMaterial for the cube's LEDs.
//
// Why not InstancedMesh of sphereGeometry?
//   - 1000 spheres × 48 triangles = 48k triangles before bloom. Points
//     renders 1000 billboards as 1000 quads (~2k triangles).
//   - Sphere silhouettes flicker at grid-aligned angles because the
//     low-poly tessellation samples the same edge pixels.
//   - The bloom post-pass already does the soft-glow work we really
//     wanted; a single billboarded quad with a radial falloff is the
//     correct primitive to feed it.
//
// Why not THREE.PointsMaterial?
//   - Its size attenuation math is coupled to a `scale` uniform the
//     renderer sets to canvas.height * 0.5, which makes picking a
//     world-space LED diameter awkward. The fragment shader also can't
//     emit our specific core + halo falloff without a texture.
//
// The vertex shader replicates perspective size attenuation manually so
// `uSizeMeters` stays in world units — set it from spacing() and the
// point holds its physical size as the camera orbits. The fragment
// shader does a two-stop radial falloff that reads as a bright core
// with a soft halo (bloom picks up the halo and widens it further).

const VERT = /* glsl */`
  attribute vec3 color;
  varying vec3 vColor;
  uniform float uSizeMeters;
  uniform float uPxPerMeter; // viewport_height * 0.5 / tan(fov/2)

  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // gl_PointSize is pixels on screen. Derived from standard perspective
    // projection: world_height × pxPerMeter / depth.
    float size = uSizeMeters * uPxPerMeter / -mv.z;
    // Clamp so LEDs stay visible when the user dollies way out without
    // shrinking below 1 px (which would flicker against the bloom grid).
    gl_PointSize = max(size, 1.5);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vColor;

  void main() {
    // gl_PointCoord is [0,1]² across the billboard quad. Centered UV.
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;
    if (r > 1.0) discard;

    // Two-stop falloff: a bright core that reads as the LED die itself,
    // then a long soft halo that bloom will smear into a glow.
    float core = smoothstep(0.55, 0.0, r);
    float halo = exp(-r * r * 3.0);
    float alpha = max(core, halo * 0.55);

    // Boost the core so even dim (post-ABL) colors still read as a point
    // of light rather than a muddy circle. 1 + core*0.6 on the RGB means
    // the center is ~1.6× the linear color; bloom likes the spike.
    vec3 rgb = vColor * (1.0 + core * 0.6);
    gl_FragColor = vec4(rgb, alpha);
  }
`;

export function createLedPointsMaterial(sizeMeters: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSizeMeters: { value: sizeMeters },
      uPxPerMeter: { value: 800 }, // placeholder — updated per frame
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // Additive blending lets overlapping halos stack — matches how a
    // photo of a real LED cube looks and cooperates with bloom's
    // threshold-luminance pass.
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}
