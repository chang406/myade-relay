import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export class JsonFile<T> {
  constructor(private readonly filename: string, private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>, private readonly empty: T) {}

  read(): T {
    try {
      return this.schema.parse(JSON.parse(fs.readFileSync(this.filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.empty);
      throw error;
    }
  }

  write(value: T): void {
    const parsed = this.schema.parse(value);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(parsed, null, 2), "utf8");
      fs.renameSync(temporary, this.filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
