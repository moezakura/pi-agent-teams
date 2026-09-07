import * as fs from "node:fs/promises";
import { getTeamConfigPath, type TeamConfig } from "./team-config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Spawn must not silently replace unreadable config or overlook malformed members. */
export async function assertSpawnConfigReadable(teamDir: string): Promise<TeamConfig | null> {
	const file = getTeamConfigPath(teamDir);
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (err) {
		if (isRecord(err) && err.code === "ENOENT") return null;
		throw err;
	}
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value) || value.version !== 1 ||
		!["teamId", "taskListId", "leadName", "createdAt", "updatedAt"].every((key) => typeof value[key] === "string") ||
		!Array.isArray(value.members) || !value.members.every((member: unknown) =>
			isRecord(member) && typeof member.name === "string" && typeof member.addedAt === "string" &&
			(member.role === "lead" || member.role === "worker") && (member.status === "online" || member.status === "offline"))) {
		throw new Error(`Invalid team config for spawn: ${file}`);
	}
	return value as unknown as TeamConfig;
}
