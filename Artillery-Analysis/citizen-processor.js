"use strict";
function measurePayloadSize(requestParams, response, context, ee, next) {
  try {
    if (response && response.body) {
      const raw = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      const sizeKB = (Buffer.byteLength(raw, "utf-8") / 1024).toFixed(1);
      ee.emit("customStat", { stat: "payload_size_kb", value: parseFloat(sizeKB) });
      try {
        const data = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
        if (Array.isArray(data)) ee.emit("customStat", { stat: "event_count", value: data.length });
      } catch (_) {}
    }
  } catch (_) {}
  return next();
}
module.exports = { measurePayloadSize };