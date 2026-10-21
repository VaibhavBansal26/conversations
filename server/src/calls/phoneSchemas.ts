import { z } from "zod";

export const PhoneCallBody = z.object({ agent_phone: z.string().trim().min(5).max(40) });
