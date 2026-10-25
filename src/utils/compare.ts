/**
 * Orders strings by UTF-16 code unit, which is what a bare `.sort()` does.
 * Not `localeCompare`: an order that feeds a hash or a stored key must not move
 * with the runtime's locale data.
 */
export const compareCodeUnits = (a: string, b: string): number => Number(a > b) - Number(a < b);
