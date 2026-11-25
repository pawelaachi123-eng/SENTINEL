'use strict';

/** Classical physics formulas with SI units stated in every description. */
const N = { type: 'number' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const result = (value, unit) => ({ ok: true, value, unit });
const fmt = (data) => `${Number(data.value.toPrecision(10))}${data.unit ? ` ${data.unit}` : ''}`;
const finite = (value, label) => { if (!Number.isFinite(value)) throw Object.assign(new Error(`${label} is not finite`), { code: 'NON_FINITE' }); return value; };
const positive = (value, label) => { if (!(value > 0)) throw Object.assign(new Error(`${label} must be positive`), { code: 'BAD_VALUE' }); return value; };

function tool(name, title, description, properties, run, example, expect, unit = '') {
  return { name, title, description, category: 'science', permission: 'read', tags: ['physics', 'science', 'pure'], parameters: object(properties), examples: [{ args: example, expect }], async run(args) { return result(finite(run(args), name), unit); }, format: fmt };
}

module.exports = [
  tool('phys.velocity', 'Average velocity', 'Displacement in metres divided by time in seconds (m/s).', { displacement: N, time: N }, (a) => a.displacement / positive(a.time, 'time'), { displacement: 100, time: 10 }, 10, 'm/s'),
  tool('phys.acceleration', 'Acceleration', 'Change in velocity in m/s over time in s (m/s²).', { deltaVelocity: N, time: N }, (a) => a.deltaVelocity / positive(a.time, 'time'), { deltaVelocity: 20, time: 4 }, 5, 'm/s²'),
  tool('phys.force', 'Newton force', 'F = ma with mass in kg and acceleration in m/s² (N).', { mass: { ...N, minimum: 0 }, acceleration: N }, (a) => a.mass * a.acceleration, { mass: 2, acceleration: 3 }, 6, 'N'),
  tool('phys.weight', 'Weight near Earth', 'W = mg using standard gravity 9.80665 m/s² (N).', { mass: { ...N, minimum: 0 } }, (a) => a.mass * 9.80665, { mass: 10 }, 98.0665, 'N'),
  tool('phys.work', 'Mechanical work', 'W = Fd cosθ with force in N, distance in m and angle in radians.', { force: N, distance: N, angleRadians: N }, (a) => a.force * a.distance * Math.cos(a.angleRadians), { force: 10, distance: 2, angleRadians: 0 }, 20, 'J'),
  tool('phys.power', 'Power', 'Work in joules divided by time in seconds (W).', { work: N, time: N }, (a) => a.work / positive(a.time, 'time'), { work: 100, time: 4 }, 25, 'W'),
  tool('phys.kinetic_energy', 'Kinetic energy', 'K = ½mv² with mass in kg and speed in m/s (J).', { mass: { ...N, minimum: 0 }, velocity: N }, (a) => 0.5 * a.mass * a.velocity ** 2, { mass: 2, velocity: 3 }, 9, 'J'),
  tool('phys.potential_energy', 'Gravitational potential energy', 'Gravitational potential energy mgh using standard gravity.', { mass: { ...N, minimum: 0 }, height: N }, (a) => a.mass * 9.80665 * a.height, { mass: 2, height: 5 }, 98.0665, 'J'),
  tool('phys.ohms_law_voltage', 'Ohm voltage', 'V = IR with current in A and resistance in Ω (V).', { current: N, resistance: { ...N, minimum: 0 } }, (a) => a.current * a.resistance, { current: 2, resistance: 5 }, 10, 'V'),
  tool('phys.ohms_law_current', 'Ohm current', 'I = V/R with voltage in V and non-zero resistance in Ω (A).', { voltage: N, resistance: N }, (a) => a.voltage / positive(a.resistance, 'resistance'), { voltage: 10, resistance: 5 }, 2, 'A'),
  tool('phys.ohms_law_resistance', 'Ohm resistance', 'R = V/I with voltage in V and non-zero current in A (Ω).', { voltage: N, current: N }, (a) => a.voltage / positive(a.current, 'current'), { voltage: 10, current: 2 }, 5, 'Ω'),
  tool('phys.electrical_power', 'Electrical power', 'P = VI with voltage in V and current in A (W).', { voltage: N, current: N }, (a) => a.voltage * a.current, { voltage: 230, current: 2 }, 460, 'W'),
  tool('phys.density', 'Density', 'Mass in kg divided by volume in m³ (kg/m³).', { mass: { ...N, minimum: 0 }, volume: N }, (a) => a.mass / positive(a.volume, 'volume'), { mass: 10, volume: 2 }, 5, 'kg/m³'),
  tool('phys.pressure', 'Pressure', 'Pressure from force in newtons and area in square metres.', { force: N, area: N }, (a) => a.force / positive(a.area, 'area'), { force: 100, area: 2 }, 50, 'Pa'),
  tool('phys.heat_energy', 'Sensible heat', 'Q = mcΔT with mass kg, specific heat J/(kg·K), temperature change K (J).', { mass: { ...N, minimum: 0 }, specificHeat: N, deltaTemperature: N }, (a) => a.mass * a.specificHeat * a.deltaTemperature, { mass: 1, specificHeat: 4186, deltaTemperature: 10 }, 41860, 'J'),
  tool('phys.wavelength', 'Wavelength', 'λ = v/f for wave speed m/s and positive frequency Hz (m).', { speed: N, frequency: N }, (a) => a.speed / positive(a.frequency, 'frequency'), { speed: 343, frequency: 343 }, 1, 'm'),
  tool('phys.wave_frequency', 'Wave frequency', 'Wave frequency from speed and wavelength in SI units.', { speed: N, wavelength: N }, (a) => a.speed / positive(a.wavelength, 'wavelength'), { speed: 343, wavelength: 1 }, 343, 'Hz'),
  tool('phys.photon_energy', 'Photon energy', 'E = hf using Planck constant 6.62607015e−34 J·s (J).', { frequency: N }, (a) => 6.62607015e-34 * a.frequency, { frequency: 1e15 }, 6.62607015e-19, 'J'),
  tool('phys.gravitational_force', 'Newtonian gravity', 'F = Gm₁m₂/r² with masses in kg and separation in m (N).', { mass1: { ...N, minimum: 0 }, mass2: { ...N, minimum: 0 }, distance: N }, (a) => (6.67430e-11 * a.mass1 * a.mass2) / positive(a.distance, 'distance') ** 2, { mass1: 1, mass2: 1, distance: 1 }, 6.67430e-11, 'N'),
  tool('phys.escape_velocity', 'Escape velocity', 'v = √(2GM/r) for a spherical body (m/s).', { mass: N, radius: N }, (a) => Math.sqrt((2 * 6.67430e-11 * positive(a.mass, 'mass')) / positive(a.radius, 'radius')), { mass: 5.972e24, radius: 6.371e6 }, 11186.14, 'm/s'),
  tool('phys.ideal_gas_pressure', 'Ideal gas pressure', 'P = nRT/V with n mol, T K, R=8.314462618 J/(mol·K), V m³ (Pa).', { moles: { ...N, minimum: 0 }, temperatureKelvin: { ...N, minimum: 0 }, volume: N }, (a) => (a.moles * 8.314462618 * a.temperatureKelvin) / positive(a.volume, 'volume'), { moles: 1, temperatureKelvin: 273.15, volume: 0.022414 }, 101325.0, 'Pa'),
  tool('phys.centripetal_acceleration', 'Centripetal acceleration', 'Centripetal acceleration v²/r for circular motion.', { velocity: N, radius: N }, (a) => a.velocity ** 2 / positive(a.radius, 'radius'), { velocity: 10, radius: 5 }, 20, 'm/s²'),
  tool('phys.momentum', 'Linear momentum', 'Linear momentum p=mv in kilogram metres per second.', { mass: { ...N, minimum: 0 }, velocity: N }, (a) => a.mass * a.velocity, { mass: 3, velocity: 4 }, 12, 'kg·m/s'),
];
