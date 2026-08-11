import type { ResourceLoader } from "../../core/resource-loader.ts";
import type { Skill } from "../../core/skills.ts";
import type { RuntimeSkillPolicy, RuntimeSkillsState } from "./types.ts";

export class RuntimeSkillControlUnavailableError extends Error {
	constructor() {
		super("Runtime skill control is unavailable for this resource loader");
		this.name = "RuntimeSkillControlUnavailableError";
	}
}

export class UnknownRuntimeSkillsError extends Error {
	readonly skills: string[];

	constructor(skills: string[]) {
		super(`Unknown skills: ${skills.join(", ")}`);
		this.name = "UnknownRuntimeSkillsError";
		this.skills = skills;
	}
}

export class RuntimeSkillPolicyController {
	private policy: RuntimeSkillPolicy;

	constructor(policy: RuntimeSkillPolicy = { mode: "inherit" }) {
		this.policy = clonePolicy(policy);
	}

	bind(resourceLoader: ResourceLoader): void {
		if (!resourceLoader.setSkillFilter || !resourceLoader.getAvailableSkills) {
			if (this.policy.mode === "inherit") return;
			throw new RuntimeSkillControlUnavailableError();
		}
		resourceLoader.setSkillFilter((skills) => this.filter(skills));
	}

	getPolicy(): RuntimeSkillPolicy {
		return clonePolicy(this.policy);
	}

	setPolicy(resourceLoader: ResourceLoader, policy: RuntimeSkillPolicy): void {
		this.assertKnownSkills(resourceLoader, policy);
		const previousPolicy = this.policy;
		this.policy = clonePolicy(policy);
		try {
			this.bind(resourceLoader);
		} catch (error) {
			this.policy = previousPolicy;
			throw error;
		}
	}

	assertKnownSkills(resourceLoader: ResourceLoader, policy: RuntimeSkillPolicy = this.policy): void {
		if (policy.mode === "inherit" || policy.mode === "none") return;
		const availableNames = new Set(this.getAvailableSkills(resourceLoader).skills.map((skill) => skill.name));
		const unknown = policy.skills.filter((skill) => !availableNames.has(skill));
		if (unknown.length > 0) throw new UnknownRuntimeSkillsError(unknown);
	}

	reconcile(resourceLoader: ResourceLoader): void {
		if (this.policy.mode !== "allowlist" && this.policy.mode !== "denylist") return;
		const availableNames = new Set(this.getAvailableSkills(resourceLoader).skills.map((skill) => skill.name));
		this.policy = {
			mode: this.policy.mode,
			skills: this.policy.skills.filter((skill) => availableNames.has(skill)),
		};
	}

	getState(resourceLoader: ResourceLoader): RuntimeSkillsState {
		const available = this.getAvailableSkills(resourceLoader);
		const enabledNames = new Set(resourceLoader.getSkills().skills.map((skill) => skill.name));
		return {
			policy: this.getPolicy(),
			skills: available.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				sourceInfo: skill.sourceInfo,
				disableModelInvocation: skill.disableModelInvocation,
				enabled: enabledNames.has(skill.name),
			})),
			diagnostics: available.diagnostics,
		};
	}

	private filter(skills: readonly Skill[]): Skill[] {
		switch (this.policy.mode) {
			case "inherit":
				return [...skills];
			case "none":
				return [];
			case "allowlist": {
				const allowed = new Set(this.policy.skills);
				return skills.filter((skill) => allowed.has(skill.name));
			}
			case "denylist": {
				const denied = new Set(this.policy.skills);
				return skills.filter((skill) => !denied.has(skill.name));
			}
		}
	}

	private getAvailableSkills(resourceLoader: ResourceLoader) {
		if (!resourceLoader.getAvailableSkills) throw new RuntimeSkillControlUnavailableError();
		return resourceLoader.getAvailableSkills();
	}
}

function clonePolicy(policy: RuntimeSkillPolicy): RuntimeSkillPolicy {
	return policy.mode === "allowlist" || policy.mode === "denylist"
		? { mode: policy.mode, skills: [...policy.skills] }
		: { mode: policy.mode };
}
