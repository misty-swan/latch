import { z } from "zod";
import { CATEGORIES, ERROR_CODES, INTENT_FORMS } from "./constants";

export const intentFormSchema = z.enum(INTENT_FORMS);
export const categorySchema = z.enum(CATEGORIES);
export const errorCodeSchema = z.enum(ERROR_CODES);
