export const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text);

export const nonempty = (value: unknown): value is string[] => texts(value) && value.length > 0;

export const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;

export function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function demand(
  value: unknown,
  message = "artifact does not satisfy its minimum phase contract",
): asserts value {
  if (!value) throw new Error(message);
}
