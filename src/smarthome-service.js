'use strict';

const store = require('./store');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function formatTime(value) {
  const [hoursRaw, minutesRaw] = String(value || '19:00').split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw) || 0;
  if (!Number.isFinite(hours)) return String(value || '19:00');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function deviceSummary(device) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    room: device.room,
    status: device.status,
    state: { ...(device.state || {}) },
  };
}

function inferScene(args) {
  const text = normalize(
    `${args.scene || ''} ${args.room || ''} ${args.context || ''} ${args.routine || ''}`,
  );
  if (/patio|taco|latin|warm|friday/.test(text)) {
    return {
      id: 'scene_patio_warm',
      name: args.scene || 'Patio Warm Glow',
      room: 'Patio',
      devices: ['hue-patio', 'echo-dot-patio'],
      state: { color: 'Warm Amber', hex: '#ffb86b', brightness: 45, power: 'on' },
    };
  }
  if (/bedroom|flight|wake|sleep|recovery|sick/.test(text)) {
    return {
      id: 'scene_bedroom_rest',
      name: args.scene || 'Restful Bedroom',
      room: 'Bedroom',
      devices: ['thermostat-bedroom', 'humidifier-bedroom', 'echo-show-15'],
      state: { targetTempF: 68, mode: 'auto', humidifier: 'low', lights: 20 },
    };
  }
  if (/movie|cinema|dim/.test(text)) {
    return {
      id: 'scene_movie_dim',
      name: args.scene || 'Movie Night Dim',
      room: args.room || 'Living Room',
      devices: ['hue-patio'],
      state: { color: 'Deep Indigo', hex: '#4c4f9e', brightness: 18 },
    };
  }
  return {
    id: `scene_${normalize(args.scene || args.room || 'custom').replace(/[^a-z0-9]+/g, '_')}`,
    name: args.scene || 'Household Scene',
    room: args.room || 'Whole Home',
    devices: ['echo-show-15'],
    state: { volume: 4 },
  };
}

function upsertScene(memory, scene) {
  const scenes = Array.isArray(memory.scenes) ? memory.scenes : [];
  const index = scenes.findIndex(
    (entry) =>
      entry.id === scene.id || normalize(entry.name) === normalize(scene.name),
  );
  const saved = {
    ...(index >= 0 ? scenes[index] : { createdAt: new Date().toISOString() }),
    ...scene,
    updatedAt: new Date().toISOString(),
  };
  if (index >= 0) scenes[index] = saved;
  else scenes.push(saved);
  memory.scenes = scenes;
  return saved;
}

function findDevice(memory, id) {
  return (memory.connectedDevices || []).find((device) => device.id === id) || null;
}

function command(device, capability, from, to, extra = {}) {
  return {
    deviceId: device?.id || extra.deviceId || null,
    deviceName: device?.name || extra.deviceName || 'Smart home device',
    room: device?.room || extra.room || 'Home',
    capability,
    from,
    to,
    status: extra.status || 'applied',
    schedule: extra.schedule || null,
  };
}

function sceneSchedule(args) {
  const time = args.time || args.schedule?.time || null;
  const days = Array.isArray(args.days)
    ? args.days
    : Array.isArray(args.schedule?.days)
      ? args.schedule.days
      : null;
  if (!time) return null;
  return {
    days: days && days.length ? days : ['Friday'],
    time,
    label: `${days && days.length ? days.join(', ') : 'Friday'} at ${formatTime(time)}`,
  };
}

function setScene(memory, args) {
  const inferred = inferScene(args);
  const schedule = sceneSchedule(args);
  const lightSelection = args.lights || {};
  const desired = {
    ...inferred.state,
    ...(lightSelection.color ? { color: lightSelection.color } : {}),
    ...(lightSelection.hex ? { hex: lightSelection.hex } : {}),
    ...(lightSelection.brightness !== undefined
      ? { brightness: Number(lightSelection.brightness) }
      : {}),
    ...(lightSelection.power ? { power: lightSelection.power } : {}),
  };

  const commands = [];
  for (const deviceId of inferred.devices) {
    const device = findDevice(memory, deviceId);
    if (!device) continue;
    const before = { ...(device.state || {}) };
    if (device.type.includes('light')) {
      device.state = {
        ...before,
        power: desired.power || 'on',
        brightness: desired.brightness ?? before.brightness ?? 40,
        color: desired.color || before.color || 'Warm White',
        hex: desired.hex || before.hex || '#ffd6a5',
      };
      commands.push(
        command(
          device,
          'ColorLight',
          `${before.power || 'off'} · ${before.brightness ?? 0}% · ${before.color || 'n/a'}`,
          `${device.state.power} · ${device.state.brightness}% · ${device.state.color}`,
        ),
      );
    } else if (device.type.includes('echo')) {
      device.state = { ...before, volume: before.volume ?? 4, scene: inferred.name };
      commands.push(
        command(device, 'MediaPlayback', 'idle', `scene ambience for ${inferred.name}`),
      );
    } else {
      device.state = { ...before, scene: inferred.name };
      commands.push(command(device, 'SceneMembership', 'unlinked', inferred.name));
    }
  }

  const saved = upsertScene(memory, {
    id: inferred.id,
    name: inferred.name,
    room: inferred.room,
    status: schedule ? 'scheduled' : 'active',
    schedule,
    devices: inferred.devices,
    state: desired,
  });

  if (schedule) {
    commands.push({
      deviceId: null,
      deviceName: `${inferred.name} automation`,
      room: inferred.room,
      capability: 'Schedule',
      from: 'unscheduled',
      to: schedule.label,
      status: 'scheduled',
      schedule,
    });
  }

  return {
    scene: saved,
    commands,
    scheduled: schedule,
    message: schedule
      ? `${saved.name} scheduled for ${schedule.label}.`
      : `${saved.name} applied now.`,
    speech: schedule
      ? `${saved.name} is scheduled for ${schedule.label}. ${
          commands[0]
            ? `${commands[0].deviceName} will change to ${commands[0].to}.`
            : ''
        }`
      : `${saved.name} is active. ${commands[0] ? `${commands[0].deviceName} is now ${commands[0].to}.` : ''}`,
  };
}

function adjustClimate(memory, args) {
  const room = args.room || args.climate?.room || 'Bedroom';
  const targetTempF = Number(
    args.climate?.targetTempF ?? args.targetTempF ?? args.temperature ?? 68,
  );
  const mode = args.climate?.mode || args.mode || 'auto';
  const commands = [];

  const thermostat = (memory.connectedDevices || []).find(
    (device) => device.room === room && device.type.includes('thermostat'),
  );
  if (thermostat) {
    const before = { ...(thermostat.state || {}) };
    thermostat.state = {
      ...before,
      targetTempF,
      mode,
      humidity: before.humidity ?? 42,
    };
    commands.push(
      command(
        thermostat,
        'Thermostat',
        `${before.targetTempF ?? 70}°F · ${before.mode || 'auto'}`,
        `${targetTempF}°F · ${mode}`,
      ),
    );
  }

  const humidifierSetting = args.humidifier || args.climate?.humidifier;
  const humidifier = (memory.connectedDevices || []).find(
    (device) => device.room === room && device.type.includes('humidifier'),
  );
  if (humidifier && humidifierSetting) {
    const before = { ...(humidifier.state || {}) };
    const power =
      typeof humidifierSetting === 'string'
        ? humidifierSetting === 'low' || humidifierSetting === 'high'
          ? 'on'
          : humidifierSetting
        : humidifierSetting?.power || 'on';
    const level =
      typeof humidifierSetting === 'string'
        ? humidifierSetting
        : humidifierSetting?.level || 'low';
    humidifier.state = {
      ...before,
      power: power || 'on',
      level: level === 'high' ? 'high' : 'low',
    };
    commands.push(
      command(
        humidifier,
        'Humidifier',
        `${before.power || 'off'} · ${before.level || 'low'}`,
        `${humidifier.state.power} · ${humidifier.state.level}`,
      ),
    );
  }

  const savedScene = upsertScene(memory, {
    id: 'scene_bedroom_rest',
    name: args.scene || 'Restful Bedroom',
    room,
    status: 'active',
    schedule: sceneSchedule(args),
    devices: [thermostat?.id, humidifier?.id].filter(Boolean),
    state: {
      targetTempF,
      mode,
      humidifier: typeof humidifierSetting === 'string' ? humidifierSetting : 'low',
    },
  });

  return {
    scene: savedScene,
    commands,
    scheduled: null,
    message: `${room} climate adjusted to ${targetTempF}°F${
      humidifierSetting ? ` with humidifier ${humidifier?.state?.power || 'on'}` : ''
    }.`,
    speech: `I set the ${room.toLowerCase()} to ${targetTempF} degrees${
      humidifierSetting
        ? ` and turned the humidifier ${
            humidifier?.state?.power || 'on'
          } on ${humidifier?.state?.level || 'low'}`
        : ''
    }.`,
  };
}

function runRoutine(memory, args) {
  const routineInput =
    args.routine && typeof args.routine === 'object'
      ? args.routine
      : {
          name: typeof args.routine === 'string' ? args.routine : 'Flight Day Wake-Up',
        };
  const name = routineInput.name || args.scene || 'Flight Day Wake-Up';
  const time = routineInput.time || args.time || '06:00';
  const days = routineInput.days || args.days || ['Monday'];
  const routines = Array.isArray(memory.routines) ? memory.routines : [];
  const index = routines.findIndex((entry) => normalize(entry.name) === normalize(name));
  const actions =
    routineInput.actions ||
    [
      'Bedroom thermostat to 68°F',
      'Humidifier on low',
      'Flight status + weather briefing at 6:00 AM',
      'Traffic + departure reminder',
    ];
  const saved = {
    ...(index >= 0 ? routines[index] : { id: `routine_${store.uuid()}`, createdAt: new Date().toISOString() }),
    name,
    time,
    days,
    status: 'active',
    actions,
    updatedAt: new Date().toISOString(),
  };
  if (index >= 0) routines[index] = saved;
  else routines.push(saved);
  memory.routines = routines;

  const echo = findDevice(memory, 'echo-show-15');
  const commands = [
    command(
      echo,
      'Routine',
      'inactive',
      `${name} · ${days.join(', ')} at ${formatTime(time)}`,
      {
        deviceName: 'Kitchen Echo Show 15',
        room: 'Kitchen',
        status: 'scheduled',
        schedule: { days, time },
      },
    ),
  ];

  return {
    routine: saved,
    commands,
    scheduled: { days, time, label: `${days.join(', ')} at ${formatTime(time)}` },
    message: `${name} is active for ${days.join(', ')} at ${formatTime(time)}.`,
    speech: `${name} is set for ${formatTime(time)}. I'll brief you on weather, traffic, and your flight status.`,
  };
}

function armSecurity(memory, args) {
  const mode = normalize(args.security?.mode || args.mode || 'armed_home');
  const commands = [];
  for (const device of memory.connectedDevices || []) {
    if (!device.type.includes('ring')) continue;
    const before = device.state?.securityMode || 'disarmed';
    device.state = { ...(device.state || {}), securityMode: mode };
    commands.push(
      command(
        device,
        'SecurityMode',
        before,
        mode.replace(/_/g, ' '),
      ),
    );
  }
  return {
    securityMode: mode,
    commands,
    scheduled: null,
    message: `Ring security set to ${mode.replace(/_/g, ' ')}.`,
    speech: `Ring cameras and doorbell are now ${mode.replace(/_/g, ' ')}.`,
  };
}

function smarthomeOrchestrateScene(args = {}) {
  const memory = store.readMemory();
  let action = normalize(args.action) || 'get_status';

  if (action === 'get' || action === 'status' || action === 'get_status') {
    return {
      action: 'get_status',
      devices: (memory.connectedDevices || []).map(deviceSummary),
      scenes: (memory.scenes || []).map((scene) => ({ ...scene })),
      routines: (memory.routines || []).map((routine) => ({ ...routine })),
      commands: [],
      scheduled: null,
      message: 'Smart home status loaded.',
      speech: `${(memory.connectedDevices || []).filter((device) => device.status === 'online').length} connected devices are online across ${new Set(
        (memory.connectedDevices || []).map((device) => device.room),
      ).size} rooms.`,
    };
  }

  if (action === 'adjust' || action === 'adjust_climate' || action === 'climate') {
    action = 'adjust_climate';
  }
  if (action === 'schedule' || action === 'schedule_scene') {
    action = 'set_scene';
  }
  if (action === 'security' || action === 'arm' || action === 'arm_security') {
    action = 'arm_security';
  }

  if (action !== 'set_scene' && action !== 'adjust_climate' && action !== 'run_routine' && action !== 'arm_security') {
    const error = new Error(
      `Unsupported smart home action "${action}". Use set_scene, adjust_climate, run_routine, arm_security, or get_status.`,
    );
    error.code = 'INVALID_OPERATION';
    throw error;
  }

  const updated = store.updateMemory((draft) => {
    let result;
    if (action === 'set_scene') result = setScene(draft, args);
    else if (action === 'adjust_climate') result = adjustClimate(draft, args);
    else if (action === 'run_routine') result = runRoutine(draft, args);
    else result = armSecurity(draft, args);

    const devices = (draft.connectedDevices || []).map(deviceSummary);
    return { ...result, devices };
  });

  const { memory: nextMemory, result } = updated;

  return {
    action,
    scene: result.scene || null,
    routine: result.routine || null,
    securityMode: result.securityMode || null,
    commands: result.commands || [],
    scheduled: result.scheduled || null,
    devices: result.devices,
    scenes: nextMemory.scenes,
    routines: nextMemory.routines,
    message: result.message,
    speech: result.speech,
    card: {
      type: 'AlexaPlusSmartHomeCard',
      title: result.scene?.name || result.routine?.name || 'Smart Home',
      subtitle: result.message,
      scheduled: result.scheduled,
      state: result.scene?.state || result.routine || null,
    },
  };
}

module.exports = { smarthomeOrchestrateScene };
