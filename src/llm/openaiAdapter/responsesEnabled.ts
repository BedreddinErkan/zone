export function responsesEnabled(): boolean {
  return process.env.ZONE_OPENAI_RESPONSES === "1";
}
