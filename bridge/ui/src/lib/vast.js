/**
 * Mirrors registry.activeBurnRatePerHour's filter exactly: a destroyed
 * instance costs nothing, and a stopped one costs storage but not the hourly
 * GPU rate the burn figure reports. Counting either as "billing" next to that
 * figure would make the two disagree on screen.
 */
export const isBilling = (instance) =>
  instance.status !== "destroyed" && instance.live?.actualStatus !== "stopped";

/** Everything this bridge still tracks — stopped instances included. */
export const isManaged = (instance) => instance.status !== "destroyed";

export const billingCount = (instances) => (instances || []).filter(isBilling).length;
