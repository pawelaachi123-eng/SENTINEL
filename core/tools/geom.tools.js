'use strict';

/** Euclidean geometry with positive-dimension validation. */
const NUM = { type: 'number', minimum: 0 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value) => ({ ok: true, value });
const fmt = (data) => (typeof data.value === 'number' ? String(Number(data.value.toPrecision(12))) : JSON.stringify(data.value).slice(0, 200));
const positive = (value, name) => { if (!(value > 0)) throw Object.assign(new Error(`${name} must be positive`), { code: 'BAD_DIMENSION' }); };
const nonNegative = (value, name) => { if (value < 0) throw Object.assign(new Error(`${name} must be non-negative`), { code: 'BAD_DIMENSION' }); };

function tool(name, title, description, properties, run, example, expect) {
  return { name, title, description, category: 'geometry', permission: 'read', tags: ['geometry', 'math', 'pure'], parameters: object(properties), examples: [{ args: example, expect }], async run(args) { const value = run(args); return result(value); }, format: fmt };
}

module.exports = [
  tool('geom.circle_area', 'Circle area', 'Area of a circle from its radius, computed as πr².', { r: NUM }, (a) => { nonNegative(a.r, 'r'); return Math.PI * a.r ** 2; }, { r: 2 }, 4 * Math.PI),
  tool('geom.circle_circumference', 'Circle circumference', 'Circumference of a circle from its radius, 2πr.', { r: NUM }, (a) => { nonNegative(a.r, 'r'); return 2 * Math.PI * a.r; }, { r: 3 }, 6 * Math.PI),
  tool('geom.triangle_area_base_height', 'Triangle area (base × height)', 'Area bh/2 for a triangle with a known base and height.', { base: NUM, height: NUM }, (a) => { nonNegative(a.base, 'base'); nonNegative(a.height, 'height'); return (a.base * a.height) / 2; }, { base: 6, height: 4 }, 12),
  tool('geom.triangle_area_heron', 'Triangle area (Heron)', 'Heron area from three side lengths; rejects a triangle inequality violation.', { a: NUM, b: NUM, c: NUM }, (x) => {
    positive(x.a, 'a'); positive(x.b, 'b'); positive(x.c, 'c');
    if (x.a + x.b <= x.c || x.a + x.c <= x.b || x.b + x.c <= x.a) throw Object.assign(new Error('sides do not form a triangle'), { code: 'BAD_TRIANGLE' });
    const s = (x.a + x.b + x.c) / 2; return Math.sqrt(s * (s - x.a) * (s - x.b) * (s - x.c));
  }, { a: 3, b: 4, c: 5 }, 6),
  tool('geom.rectangle_area', 'Rectangle area', 'Area of a rectangle from width and height.', { width: NUM, height: NUM }, (a) => { nonNegative(a.width, 'width'); nonNegative(a.height, 'height'); return a.width * a.height; }, { width: 4, height: 5 }, 20),
  tool('geom.rectangle_perimeter', 'Rectangle perimeter', 'Perimeter of a rectangle, 2(width + height).', { width: NUM, height: NUM }, (a) => { nonNegative(a.width, 'width'); nonNegative(a.height, 'height'); return 2 * (a.width + a.height); }, { width: 4, height: 5 }, 18),
  tool('geom.square_area', 'Square area', 'Area of a square from the length of one side.', { side: NUM }, (a) => { nonNegative(a.side, 'side'); return a.side ** 2; }, { side: 7 }, 49),
  tool('geom.sphere_volume', 'Sphere volume', 'Volume of a sphere, 4πr³/3, from its radius.', { r: NUM }, (a) => { nonNegative(a.r, 'r'); return (4 / 3) * Math.PI * a.r ** 3; }, { r: 3 }, 36 * Math.PI),
  tool('geom.sphere_surface', 'Sphere surface area', 'Surface area of a sphere, 4πr², from its radius.', { r: NUM }, (a) => { nonNegative(a.r, 'r'); return 4 * Math.PI * a.r ** 2; }, { r: 2 }, 16 * Math.PI),
  tool('geom.cylinder_volume', 'Cylinder volume', 'Volume of a right circular cylinder, πr²h.', { r: NUM, height: NUM }, (a) => { nonNegative(a.r, 'r'); nonNegative(a.height, 'height'); return Math.PI * a.r ** 2 * a.height; }, { r: 2, height: 5 }, 20 * Math.PI),
  tool('geom.cone_volume', 'Cone volume', 'Volume of a right circular cone, πr²h/3.', { r: NUM, height: NUM }, (a) => { nonNegative(a.r, 'r'); nonNegative(a.height, 'height'); return (Math.PI * a.r ** 2 * a.height) / 3; }, { r: 3, height: 4 }, 12 * Math.PI),
  tool('geom.cuboid_volume', 'Cuboid volume', 'Volume of a rectangular cuboid from three edges.', { length: NUM, width: NUM, height: NUM }, (a) => { nonNegative(a.length, 'length'); nonNegative(a.width, 'width'); nonNegative(a.height, 'height'); return a.length * a.width * a.height; }, { length: 2, width: 3, height: 4 }, 24),
  tool('geom.distance_2d', '2D distance', 'Euclidean distance between two points in the plane.', { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, (a) => Math.hypot(a.x2 - a.x1, a.y2 - a.y1), { x1: 0, y1: 0, x2: 3, y2: 4 }, 5),
  tool('geom.distance_3d', '3D distance', 'Euclidean distance between two 3D points.', { x1: { type: 'number' }, y1: { type: 'number' }, z1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, z2: { type: 'number' } }, (a) => Math.hypot(a.x2 - a.x1, a.y2 - a.y1, a.z2 - a.z1), { x1: 0, y1: 0, z1: 0, x2: 2, y2: 3, z2: 6 }, 7),
  tool('geom.midpoint_2d', '2D midpoint', 'Midpoint of two planar points as an [x, y] pair.', { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, (a) => [(a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2], { x1: 0, y1: 0, x2: 4, y2: 8 }, [2, 4]),
  tool('geom.slope', 'Line slope', 'Slope (y2−y1)/(x2−x1); a vertical line is rejected rather than returning Infinity.', { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, (a) => { if (a.x1 === a.x2) throw Object.assign(new Error('vertical line has no finite slope'), { code: 'VERTICAL' }); return (a.y2 - a.y1) / (a.x2 - a.x1); }, { x1: 1, y1: 2, x2: 3, y2: 6 }, 2),
  tool('geom.point_line_distance', 'Point-to-line distance', 'Perpendicular distance from a point to the line ax+by+c=0; a and b may not both be zero.', { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, (p) => { if (p.a === 0 && p.b === 0) throw Object.assign(new Error('line coefficients are degenerate'), { code: 'BAD_LINE' }); return Math.abs(p.a * p.x + p.b * p.y + p.c) / Math.hypot(p.a, p.b); }, { a: 1, b: 0, c: -5, x: 10, y: 3 }, 5),
  tool('geom.regular_polygon_area', 'Regular polygon area', 'Area of a regular n-gon with circumradius r; n is 3..1000.', { n: { type: 'integer', minimum: 3, maximum: 1000 }, r: NUM }, (a) => { nonNegative(a.r, 'r'); return (a.n / 2) * a.r ** 2 * Math.sin((2 * Math.PI) / a.n); }, { n: 4, r: Math.sqrt(2) }, 4),
  tool('geom.arc_length', 'Arc length', 'Length rθ for a central angle in radians; angle must be non-negative.', { r: NUM, angleRadians: NUM }, (a) => { nonNegative(a.r, 'r'); nonNegative(a.angleRadians, 'angleRadians'); return a.r * a.angleRadians; }, { r: 2, angleRadians: Math.PI }, 2 * Math.PI),
  tool('geom.sector_area', 'Sector area', 'Area r²θ/2 for a central angle in radians.', { r: NUM, angleRadians: NUM }, (a) => { nonNegative(a.r, 'r'); nonNegative(a.angleRadians, 'angleRadians'); return (a.r ** 2 * a.angleRadians) / 2; }, { r: 2, angleRadians: Math.PI }, 2 * Math.PI),
];
