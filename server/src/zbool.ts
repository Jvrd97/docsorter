import { z } from "zod";

/**
 * z.coerce.boolean() считает истиной любую непустую строку, включая "false".
 * Для переменных окружения и параметров запроса нужен разбор по значению.
 */
export const zbool = () =>
  z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return /^(1|true|yes|on|да)$/i.test(value.trim());
    return value;
  }, z.boolean());
