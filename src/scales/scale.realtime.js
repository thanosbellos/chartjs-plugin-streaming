import {defaults, TimeScale} from 'chart.js';
import {_lookup, callback as call, each, isArray, isNumber, noop, clipArea, unclipArea} from 'chart.js/helpers';
import {resolveOption, startFrameRefreshTimer, stopFrameRefreshTimer} from '../helpers/helpers.streaming';

// Ported from Chart.js 2.8.0 35273ee.
const INTERVALS = {
  millisecond: {
    common: true,
    size: 1,
    steps: [1, 2, 5, 10, 20, 50, 100, 250, 500]
  },
  second: {
    common: true,
    size: 1000,
    steps: [1, 2, 5, 10, 15, 30]
  },
  minute: {
    common: true,
    size: 60000,
    steps: [1, 2, 5, 10, 15, 30]
  },
  hour: {
    common: true,
    size: 3600000,
    steps: [1, 2, 3, 6, 12]
  },
  day: {
    common: true,
    size: 86400000,
    steps: [1, 2, 5]
  },
  week: {
    common: false,
    size: 604800000,
    steps: [1, 2, 3, 4]
  },
  month: {
    common: true,
    size: 2.628e9,
    steps: [1, 2, 3]
  },
  quarter: {
    common: false,
    size: 7.884e9,
    steps: [1, 2, 3, 4]
  },
  year: {
    common: true,
    size: 3.154e10
  }
};

// Ported from Chart.js 2.8.0 35273ee.
const UNITS = Object.keys(INTERVALS);

// Ported from Chart.js 2.8.0 35273ee.
function determineStepSize(min, max, unit, capacity) {
  const range = max - min;
  const {size: milliseconds, steps} = INTERVALS[unit];
  let factor;

  if (!steps) {
    return Math.ceil(range / (capacity * milliseconds));
  }

  for (let i = 0, ilen = steps.length; i < ilen; ++i) {
    factor = steps[i];
    if (Math.ceil(range / (milliseconds * factor)) <= capacity) {
      break;
    }
  }

  return factor;
}

// Ported from Chart.js 2.8.0 35273ee.
function determineUnitForAutoTicks(minUnit, min, max, capacity) {
  const range = max - min;
  const ilen = UNITS.length;

  for (let i = UNITS.indexOf(minUnit); i < ilen - 1; ++i) {
    const {common, size, steps} = INTERVALS[UNITS[i]];
    const factor = steps ? steps[steps.length - 1] : Number.MAX_SAFE_INTEGER;

    if (common && Math.ceil(range / (factor * size)) <= capacity) {
      return UNITS[i];
    }
  }

  return UNITS[ilen - 1];
}

// Ported from Chart.js 2.8.0 35273ee.
function determineMajorUnit(unit) {
  for (let i = UNITS.indexOf(unit) + 1, ilen = UNITS.length; i < ilen; ++i) {
    if (INTERVALS[UNITS[i]].common) {
      return UNITS[i];
    }
  }
}

// Ported from Chart.js 3.2.0 e1404ac.
function addTick(ticks, time, timestamps) {
  if (!timestamps) {
    ticks[time] = true;
  } else if (timestamps.length) {
    const {lo, hi} = _lookup(timestamps, time);
    const timestamp = timestamps[lo] >= time ? timestamps[lo] : timestamps[hi];
    ticks[timestamp] = true;
  }
}

function getAxisKey(meta, id) {
  return id === meta.xAxisID && 'x' || id === meta.yAxisID && 'y';
}

const datasetPropertyKeys = [
  'pointBackgroundColor',
  'pointBorderColor',
  'pointBorderWidth',
  'pointRadius',
  'pointRotation',
  'pointStyle',
  'pointHitRadius',
  'pointHoverBackgroundColor',
  'pointHoverBorderColor',
  'pointHoverBorderWidth',
  'pointHoverRadius',
  'backgroundColor',
  'borderColor',
  'borderSkipped',
  'borderWidth',
  'hoverBackgroundColor',
  'hoverBorderColor',
  'hoverBorderWidth',
  'hoverRadius',
  'hitRadius',
  'radius',
  'rotation'
];

function refreshData(scale) {
  const {chart, id, max} = scale;
  const duration = resolveOption(scale, 'duration');
  const delay = resolveOption(scale, 'delay');
  const ttl = resolveOption(scale, 'ttl');
  const pause = resolveOption(scale, 'pause');
  const onRefresh = resolveOption(scale, 'onRefresh');
  const min = Date.now() - (isNaN(ttl) ? duration + delay : ttl);
  let i, start, count, removalRange;

  call(onRefresh, [chart]);

  // Remove old data
  chart.data.datasets.forEach((dataset, datasetIndex) => {
    const meta = chart.getDatasetMeta(datasetIndex);
    const axis = getAxisKey(meta, id);

    if (axis) {
      const controller = meta.controller;
      const data = dataset.data;
      const length = data.length;

      if (pause) {
        // If the scale is paused, preserve the visible data points
        for (i = 0; i < length; ++i) {
          if (!(controller.getParsed(i)[axis] < max)) {
            break;
          }
        }
        start = i + 2;
      } else {
        start = 0;
      }

      for (i = start; i < length; ++i) {
        if (!(controller.getParsed(i)[axis] <= min)) {
          break;
        }
      }
      count = i - start;
      if (isNaN(ttl)) {
        // Keep the last two data points outside the range not to affect the existing bezier curve
        count = Math.max(count - 2, 0);
      }

      data.splice(start, count);
      datasetPropertyKeys.forEach(key => {
        if (isArray(dataset[key])) {
          dataset[key].splice(start, count);
        }
      });
      each(dataset.datalabels, value => {
        if (isArray(value)) {
          value.splice(start, count);
        }
      });
      if (typeof data[0] !== 'object') {
        removalRange = {
          start: start,
          count: count
        };
      }
    }
  });
  if (removalRange) {
    chart.data.labels.splice(removalRange.start, removalRange.count);
  }

  chart.update('quiet');
}

function stopDataRefreshTimer(scale) {
  const realtime = scale.realtime;
  const refreshTimerID = realtime.refreshTimerID;

  if (refreshTimerID) {
    clearInterval(refreshTimerID);
    delete realtime.refreshTimerID;
    delete realtime.refreshInterval;
  }
}

function startDataRefreshTimer(scale) {
  const realtime = scale.realtime;
  const interval = resolveOption(scale, 'refresh');

  if (realtime.refreshTimerID) {
    return;
  }

  realtime.refreshTimerID = setInterval(() => {
    const newInterval = resolveOption(scale, 'refresh');

    refreshData(scale);
    if (realtime.refreshInterval !== newInterval && !isNaN(newInterval)) {
      stopDataRefreshTimer(scale);
      startDataRefreshTimer(scale);
    }
  }, interval);
  realtime.refreshInterval = interval;
}

const transitionKeys = {
  x: {
    data: ['x', 'controlPointPreviousX', 'controlPointNextX'],
    dataset: ['x'],
    tooltip: ['x', 'caretX']
  },
  y: {
    data: ['y', 'controlPointPreviousY', 'controlPointNextY'],
    dataset: ['y'],
    tooltip: ['y', 'caretY']
  }
};

function transition(element, keys, translate) {
  const animations = element.$animations;

  for (let i = 0, ilen = keys.length; i < ilen; ++i) {
    const key = keys[i];

    if (!isNaN(element[key])) {
      element[key] -= translate;
    }
  }
  if (animations) {
    for (let i = 0, ilen = keys.length; i < ilen; ++i) {
      const value = animations[keys[i]];

      if (value) {
        value._from -= translate;
        value._to -= translate;
      }
    }
  }
}

function scroll(scale) {
  const {chart, id, realtime} = scale;
  const duration = resolveOption(scale, 'duration');
  const delay = resolveOption(scale, 'delay');
  const isHorizontal = scale.isHorizontal();
  const tooltip = chart.tooltip;
  const activeTooltip = tooltip._active;
  const now = Date.now();
  let length, keys, offset;

  if (isHorizontal) {
    length = scale.width;
    keys = transitionKeys.x;
  } else {
    length = scale.height;
    keys = transitionKeys.y;
  }
  offset = length * (now - realtime.head) / duration;

  if (!!isHorizontal === !!scale.options.reverse) {
    offset = -offset;
  }

  // Shift all the elements leftward or upward
  each(chart.data.datasets, (dataset, datasetIndex) => {
    const meta = chart.getDatasetMeta(datasetIndex);

    if (getAxisKey(meta, id)) {
      const {data, dataset: element} = meta;
      const elements = data || [];

      for (let i = 0, ilen = elements.length; i < ilen; ++i) {
        transition(elements[i], keys.data, offset);
      }

      if (element) {
        transition(element, keys.dataset, offset);
      }
    }
  });

  // Shift tooltip leftward or upward
  if (activeTooltip && activeTooltip[0]) {
    const meta = chart.getDatasetMeta(activeTooltip[0].datasetIndex);

    if (getAxisKey(meta, id)) {
      transition(tooltip, keys.tooltip, offset);
    }
  }

  scale.max = now - delay;
  scale.min = scale.max - duration;

  realtime.head = now;
}

export default class RealTimeScale extends TimeScale {

  constructor(props) {
    super(props);
    this.realtime = this.realtime || {};
  }

  init(scaleOpts, opts) {
    super.init(scaleOpts, opts);
    startDataRefreshTimer(this);
  }

  update(maxWidth, maxHeight, margins) {
    const me = this;
    const {realtime, options} = me;
    const {bounds, offset, ticks: ticksOpts} = options;
    const {autoSkip, source, major: majorTicksOpts} = ticksOpts;
    const majorEnabled = majorTicksOpts.enabled;

    if (resolveOption(me, 'pause')) {
      stopFrameRefreshTimer(realtime);
    } else {
      startFrameRefreshTimer(realtime, () => {
        scroll(me);
      });
      realtime.head = Date.now();
    }

    options.bounds = undefined;
    options.offset = false;
    ticksOpts.autoSkip = false;
    ticksOpts.source = source === 'auto' ? '' : source;
    majorTicksOpts.enabled = true;

    super.update(maxWidth, maxHeight, margins);

    options.bounds = bounds;
    options.offset = offset;
    ticksOpts.autoSkip = autoSkip;
    ticksOpts.source = source;
    majorTicksOpts.enabled = majorEnabled;
  }

  buildTicks() {
    const me = this;
    const duration = resolveOption(me, 'duration');
    const delay = resolveOption(me, 'delay');
    const max = me.realtime.head - delay;
    const min = max - duration;
    const maxArray = [1e15, max];
    const minArray = [-1e15, min];

    Object.defineProperty(me, 'min', {
      get: () => minArray.shift(),
      set: noop
    });
    Object.defineProperty(me, 'max', {
      get: () => maxArray.shift(),
      set: noop
    });

    const ticks = super.buildTicks();

    delete me.min;
    delete me.max;
    me.min = min;
    me.max = max;

    return ticks;
  }

  calculateLabelRotation() {
    const ticksOpts = this.options.ticks;
    const maxRotation = ticksOpts.maxRotation;

    ticksOpts.maxRotation = ticksOpts.minRotation || 0;
    super.calculateLabelRotation();
    ticksOpts.maxRotation = maxRotation;
  }

  fit() {
    const me = this;
    const options = me.options;

    super.fit();

    if (options.ticks.display && options.display && me.isHorizontal()) {
      me.paddingLeft = 3;
      me.paddingRight = 3;
      me._handleMargins();
    }
  }

  draw(chartArea) {
    const me = this;
    const {chart, ctx} = me;
    const area = me.isHorizontal() ?
      {
        left: chartArea.left,
        top: 0,
        right: chartArea.right,
        bottom: chart.height
      } : {
        left: 0,
        top: chartArea.top,
        right: chart.width,
        bottom: chartArea.bottom
      };

    me._gridLineItems = null;
    me._labelItems = null;

    // Clip and draw the scale
    clipArea(ctx, area);
    super.draw(chartArea);
    unclipArea(ctx);
  }

  destroy() {
    const me = this;

    stopFrameRefreshTimer(me.realtime);
    stopDataRefreshTimer(me);
  }

  _generate() {
    const me = this;
    const adapter = me._adapter;
    const duration = resolveOption(me, 'duration');
    const delay = resolveOption(me, 'delay');
    const refresh = resolveOption(me, 'refresh');
    const max = me.realtime.head - delay;
    const min = max - duration;
    const capacity = me._getLabelCapacity(min);
    const {time: timeOpts, ticks: ticksOpts} = me.options;
    const minor = timeOpts.unit || determineUnitForAutoTicks(timeOpts.minUnit, min, max, capacity);
    const major = determineMajorUnit(minor);
    const stepSize = timeOpts.stepSize || determineStepSize(min, max, minor, capacity);
    const weekday = minor === 'week' ? timeOpts.isoWeekday : false;
    const majorTicksEnabled = ticksOpts.major.enabled;
    const hasWeekday = isNumber(weekday) || weekday === true;
    const interval = INTERVALS[minor];
    const ticks = {};
    let first = min;
    let time, count;

    // For 'week' unit, handle the first day of week option
    if (hasWeekday) {
      first = +adapter.startOf(first, 'isoWeek', weekday);
    }

    // Align first ticks on unit
    first = +adapter.startOf(first, hasWeekday ? 'day' : minor);

    // Prevent browser from freezing in case user options request millions of milliseconds
    if (adapter.diff(max, min, minor) > 100000 * stepSize) {
      throw new Error(min + ' and ' + max + ' are too far apart with stepSize of ' + stepSize + ' ' + minor);
    }

    time = first;

    if (majorTicksEnabled && major && !hasWeekday && !timeOpts.round) {
      // Align the first tick on the previous `minor` unit aligned on the `major` unit:
      // we first aligned time on the previous `major` unit then add the number of full
      // stepSize there is between first and the previous major time.
      time = +adapter.startOf(time, major);
      time = +adapter.add(time, ~~((first - time) / (interval.size * stepSize)) * stepSize, minor);
    }

    const timestamps = ticksOpts.source === 'data' && me.getDataTimestamps();
    for (count = 0; time < max + refresh; time = +adapter.add(time, stepSize, minor), count++) {
      addTick(ticks, time, timestamps);
    }

    if (time === max + refresh || count === 1) {
      addTick(ticks, time, timestamps);
    }

    return Object.keys(ticks).sort((a, b) => a - b).map(x => +x);
  }
}

RealTimeScale.id = 'realtime';

RealTimeScale.defaults = {
  bounds: 'data',
  adapters: {},
  time: {
    parser: false, // false == a pattern string from or a custom callback that converts its argument to a timestamp
    unit: false, // false == automatic or override with week, month, year, etc.
    round: false, // none, or override with week, month, year, etc.
    isoWeekday: false, // override week start day - see http://momentjs.com/docs/#/get-set/iso-weekday/
    minUnit: 'millisecond',
    displayFormats: {}
  },
  realtime: {},
  ticks: {
    autoSkip: false,
    source: 'auto',
    major: {
      enabled: true
    }
  }
};

defaults.describe('scale.realtime', {
  _scriptable: name => name !== 'onRefresh'
});
