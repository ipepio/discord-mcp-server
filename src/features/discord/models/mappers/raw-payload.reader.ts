import { MalformedRawPayloadError } from "./raw-payload.errors.js";

/**
 * Reads an untrusted Discord payload as application data (spec R3). Every accessor either narrows to
 * an application type or raises `MalformedRawPayloadError` naming the raw event, the field path and
 * the reason — never a fabricated default, never an empty stand-in for an absent value, and never a
 * value that could carry content into an error message (R11).
 */
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,20}$/;

export type RawObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is RawObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsent(value: unknown): boolean {
	return value === undefined || value === null;
}

export class RawPayloadReader {
	public constructor(private readonly rawEventName: string) {}

	/** The payload root itself. */
	public root(payload: unknown): RawObject {
		if (!isObject(payload)) {
			this.reject("", "the payload is not an object");
		}

		return payload;
	}

	/** Required snowflake identifier. */
	public requireId(source: RawObject, field: string, path?: string): string {
		const value = source[field];
		if (typeof value !== "string" || !SNOWFLAKE_PATTERN.test(value)) {
			this.reject(this.pathOf(field, path), "expected a Discord snowflake string");
		}

		return value;
	}

	/** Optional identifier: absent stays absent, a malformed value is rejected. */
	public optionalId(source: RawObject, field: string, path?: string): string | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (typeof value !== "string" || !SNOWFLAKE_PATTERN.test(value)) {
			this.reject(this.pathOf(field, path), "expected a Discord snowflake string or no value at all");
		}

		return value;
	}

	public requireString(source: RawObject, field: string, path?: string): string {
		const value = source[field];
		if (typeof value !== "string") {
			this.reject(this.pathOf(field, path), "expected a string");
		}

		return value;
	}

	/** Optional text field. Content values are read into memory and never logged (R11). */
	public optionalString(source: RawObject, field: string, path?: string): string | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (typeof value !== "string") {
			this.reject(this.pathOf(field, path), "expected a string or no value at all");
		}

		return value;
	}

	public optionalBoolean(source: RawObject, field: string, path?: string): boolean | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (typeof value !== "boolean") {
			this.reject(this.pathOf(field, path), "expected a boolean or no value at all");
		}

		return value;
	}

	public requireNumber(source: RawObject, field: string, path?: string): number {
		const value = source[field];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			this.reject(this.pathOf(field, path), "expected a finite number");
		}

		return value;
	}

	public optionalNumber(source: RawObject, field: string, path?: string): number | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (typeof value !== "number" || !Number.isFinite(value)) {
			this.reject(this.pathOf(field, path), "expected a finite number or no value at all");
		}

		return value;
	}

	/** Discord sends ISO-8601 strings; the application type is a `Date`. */
	public requireInstant(source: RawObject, field: string, path?: string): Date {
		const value = source[field];
		if (typeof value !== "string") {
			this.reject(this.pathOf(field, path), "expected an ISO-8601 timestamp string");
		}

		return this.instantOf(value, this.pathOf(field, path));
	}

	public optionalInstant(source: RawObject, field: string, path?: string): Date | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (typeof value !== "string") {
			this.reject(this.pathOf(field, path), "expected an ISO-8601 timestamp string or no value at all");
		}

		return this.instantOf(value, this.pathOf(field, path));
	}

	/** Required nested object. */
	public requireObject(source: RawObject, field: string, path?: string): RawObject {
		const value = source[field];
		if (!isObject(value)) {
			this.reject(this.pathOf(field, path), "expected an object");
		}

		return value;
	}

	/** Optional nested object, including the present-but-null case Discord uses for cleared fields. */
	public optionalObject(source: RawObject, field: string, path?: string): RawObject | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (!isObject(value)) {
			this.reject(this.pathOf(field, path), "expected an object or no value at all");
		}

		return value;
	}

	/** Optional list; an absent list is not an empty one, so callers branch on `undefined`. */
	public optionalArray(source: RawObject, field: string, path?: string): readonly unknown[] | undefined {
		const value = source[field];
		if (isAbsent(value)) {
			return undefined;
		}

		if (!Array.isArray(value)) {
			this.reject(this.pathOf(field, path), "expected an array or no value at all");
		}

		return value;
	}

	public requireArray(source: RawObject, field: string, path?: string): readonly unknown[] {
		const value = source[field];
		if (!Array.isArray(value)) {
			this.reject(this.pathOf(field, path), "expected an array");
		}

		return value;
	}

	/** Every id of a raw id list; one malformed entry rejects the whole payload. */
	public idList(source: RawObject, field: string, path?: string): readonly string[] {
		const list = this.requireArray(source, field, path);
		const ids: string[] = [];

		for (const entry of list) {
			if (typeof entry !== "string" || !SNOWFLAKE_PATTERN.test(entry)) {
				this.reject(this.pathOf(field, path), "expected a list of Discord snowflake strings");
			}

			ids.push(entry);
		}

		return ids;
	}

	/** Narrows an array element to an object, with the index already inside the given path. */
	public elementAsObject(entry: unknown, path: string): RawObject {
		if (!isObject(entry)) {
			this.reject(path, "expected an object entry");
		}

		return entry;
	}

	/** Validates an already-read list element by element; one bad entry rejects the whole payload. */
	public idEntryList(list: readonly unknown[], path: string): readonly string[] {
		const ids: string[] = [];

		for (const [index, entry] of list.entries()) {
			if (typeof entry !== "string" || !SNOWFLAKE_PATTERN.test(entry)) {
				this.reject(`${path}[${index}]`, "expected a Discord snowflake string");
			}

			ids.push(entry);
		}

		return ids;
	}

	/**
	 * Rejects a payload at an explicit path. Public because a code-to-name table can also fail: an
	 * overwrite target or member type Discord has changed underneath us is a malformed payload, not an
	 * invented value (R3). The reason names the field only — never a content value.
	 */
	public reject(fieldPath: string, reason: string): never {
		throw new MalformedRawPayloadError(this.rawEventName, fieldPath, reason);
	}

	/** Builds a nested field path for error reporting. */
	public childPath(parent: string, field: string): string {
		return parent === "" ? field : `${parent}.${field}`;
	}

	private instantOf(value: string, path: string): Date {
		const instant = new Date(value);
		if (Number.isNaN(instant.getTime())) {
			this.reject(path, "expected a parseable ISO-8601 timestamp");
		}

		return instant;
	}

	private pathOf(field: string, path: string | undefined): string {
		return path ?? field;
	}
}
