//@ts-nocheck

import semiver from "semiver";

import {
	process_endpoint,
	RE_SPACE_NAME,
	map_names_to_ids,
	discussions_enabled,
	get_space_hardware,
	set_space_hardware,
	set_space_timeout,
	hardware_types,
	resolve_root,
	apply_diff
} from "./utils.js";

import type {
	EventType,
	EventListener,
	ListenerMap,
	Event,
	Payload,
	PostResponse,
	UploadResponse,
	Status,
	SpaceStatus,
	SpaceStatusCallback
} from "./types.js";

import { FileData } from "./upload";

import type { Config } from "./types.js";

type event = <K extends EventType>(
	eventType: K,
	listener: EventListener<K>
) => SubmitReturn;
type predict = (
	endpoint: string | number,
	data?: unknown[],
	event_data?: unknown
) => Promise<unknown>;

type client_return = {
	predict: predict;
	config: Config;
	submit: (
		endpoint: string | number,
		data?: unknown[],
		event_data?: unknown,
		trigger_id?: number | null
	) => SubmitReturn;
	component_server: (
		component_id: number,
		fn_name: string,
		data: unknown[]
	) => any;
	view_api: (c?: Config) => Promise<ApiInfo<JsApiData>>;
};

type SubmitReturn = {
	on: event;
	off: event;
	cancel: () => Promise<void>;
	destroy: () => void;
};

const QUEUE_FULL_MSG = "This application is too busy. Keep trying!";
const BROKEN_CONNECTION_MSG = "Connection errored out.";

export let NodeBlob;

export async function duplicate(
	app_reference: string,
	options: {
		hf_token: `hf_${string}`;
		private?: boolean;
		status_callback: SpaceStatusCallback;
		hardware?: (typeof hardware_types)[number];
		timeout?: number;
	}
): Promise<client_return> {
	const { hf_token, private: _private, hardware, timeout } = options;

	if (hardware && !hardware_types.includes(hardware)) {
		throw new Error(
			`Invalid hardware type provided. Valid types are: ${hardware_types
				.map((v) => `"${v}"`)
				.join(",")}.`
		);
	}
	const headers = {
		Authorization: `Bearer ${hf_token}`
	};

	const user = (
		await (
			await fetch(`https://huggingface.co/api/whoami-v2`, {
				headers
			})
		).json()
	).name;

	const space_name = app_reference.split("/")[1];
	const body: {
		repository: string;
		private?: boolean;
	} = {
		repository: `${user}/${space_name}`
	};

	if (_private) {
		body.private = true;
	}

	try {
		const response = await fetch(
			`https://huggingface.co/api/spaces/${app_reference}/duplicate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(body)
			}
		);

		if (response.status === 409) {
			return client(`${user}/${space_name}`, options);
		}
		const duplicated_space = await response.json();

		let original_hardware;

		if (!hardware) {
			original_hardware = await get_space_hardware(app_reference, hf_token);
		}

		const requested_hardware = hardware || original_hardware || "cpu-basic";
		await set_space_hardware(
			`${user}/${space_name}`,
			requested_hardware,
			hf_token
		);

		await set_space_timeout(`${user}/${space_name}`, timeout || 300, hf_token);
		return client(duplicated_space.url, options);
	} catch (e: any) {
		throw new Error(e);
	}
}

interface Client {
	post_data: (
		url: string,
		body: unknown,
		token?: `hf_${string}`
	) => Promise<[PostResponse, number]>;
	upload_files: (
		root: string,
		files: File[],
		token?: `hf_${string}`,
		upload_id?: string
	) => Promise<UploadResponse>;
	client: (
		app_reference: string,
		options: {
			hf_token?: `hf_${string}`;
			status_callback?: SpaceStatusCallback;
		}
	) => Promise<client_return>;
	handle_blob: (
		endpoint: string,
		data: unknown[],
		api_info: ApiInfo<JsApiData>,
		token?: `hf_${string}`
	) => Promise<unknown[]>;
}

export function api_factory(
	fetch_implementation: typeof fetch,
	EventSource_factory: (url: URL) => EventSource
): Client {
	return { post_data, upload_files, client, handle_blob };

	async function post_data(
		url: string,
		body: unknown,
		token?: `hf_${string}`
	): Promise<[PostResponse, number]> {
		const headers: {
			Authorization?: string;
			"Content-Type": "application/json";
		} = { "Content-Type": "application/json" };
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		try {
			var response = await fetch_implementation(url, {
				method: "POST",
				body: JSON.stringify(body),
				headers
			});
		} catch (e) {
			return [{ error: BROKEN_CONNECTION_MSG }, 500];
		}
		let output: PostResponse;
		let status: int;
		try {
			output = await response.json();
			status = response.status;
		} catch (e) {
			output = { error: `Could not parse server response: ${e}` };
			status = 500;
		}
		return [output, status];
	}

	async function upload_files(
		root: string,
		files: (Blob | File)[],
		token?: `hf_${string}`,
		upload_id?: string
	): Promise<UploadResponse> {
		const headers: {
			Authorization?: string;
		} = {};
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		const chunkSize = 1000;
		const uploadResponses = [];
		for (let i = 0; i < files.length; i += chunkSize) {
			const chunk = files.slice(i, i + chunkSize);
			const formData = new FormData();
			chunk.forEach((file) => {
				formData.append("files", file);
			});
			try {
				const upload_url = upload_id
					? `${root}/upload?upload_id=${upload_id}`
					: `${root}/upload`;
				var response = await fetch_implementation(upload_url, {
					method: "POST",
					body: formData,
					headers
				});
			} catch (e) {
				return { error: BROKEN_CONNECTION_MSG };
			}
			const output: UploadResponse["files"] = await response.json();
			uploadResponses.push(...output);
		}
		return { files: uploadResponses };
	}

	async function client(
		app_reference: string,
		options: {
			hf_token?: `hf_${string}`;
			status_callback?: SpaceStatusCallback;
		} = {}
	): Promise<client_return> {
		return new Promise(async (res) => {
			const { status_callback, hf_token } = options;
			const return_obj = {
				predict,
				submit,
				view_api,
				component_server
			};

			if (
				(typeof window === "undefined" || !("WebSocket" in window)) &&
				!global.Websocket
			) {
				const ws = await import("ws");
				NodeBlob = (await import("node:buffer")).Blob;
				//@ts-ignore
				global.WebSocket = ws.WebSocket;
			}

			const { ws_protocol, http_protocol, host, space_id } =
				await process_endpoint(app_reference, hf_token);

			const session_hash = Math.random().toString(36).substring(2);
			const last_status: Record<string, Status["stage"]> = {};
			let stream_open = false;
			let pending_stream_messages: Record<string, any[]> = {}; // Event messages may be received by the SSE stream before the initial data POST request is complete. To resolve this race condition, we store the messages in a dictionary and process them when the POST request is complete.
			let pending_diff_streams: Record<string, any[][]> = {};
			let event_stream: EventSource | null = null;
			const event_callbacks: Record<string, () => Promise<void>> = {};
			const unclosed_events: Set<string> = new Set();
			let config: Config;
			let api_map: Record<string, number> = {};

			let jwt: false | string = false;

			if (hf_token && space_id) {
				jwt = await get_jwt(space_id, hf_token);
			}

			async function config_success(_config: Config): Promise<client_return> {
				config = _config;
				api_map = map_names_to_ids(_config?.dependencies || []);
				if (config.auth_required) {
					return {
						config,
						...return_obj
					};
				}
				try {
					api = await view_api(config);
				} catch (e) {
					console.error(`Could not get api details: ${e.message}`);
				}

				return {
					config,
					...return_obj
				};
			}
			let api: ApiInfo<JsApiData>;
			async function handle_space_sucess(status: SpaceStatus): Promise<void> {
				if (status_callback) status_callback(status);
				if (status.status === "running")
					try {
						config = await resolve_config(
							fetch_implementation,
							`${http_protocol}//${host}`,
							hf_token
						);

						const _config = await config_success(config);
						res(_config);
					} catch (e) {
						console.error(e);
						if (status_callback) {
							status_callback({
								status: "error",
								message: "Could not load this space.",
								load_status: "error",
								detail: "NOT_FOUND"
							});
						}
					}
			}

			try {
				config = await resolve_config(
					fetch_implementation,
					`${http_protocol}//${host}`,
					hf_token
				);

				const _config = await config_success(config);
				res(_config);
			} catch (e) {
				console.error(e);
				if (space_id) {
					check_space_status(
						space_id,
						RE_SPACE_NAME.test(space_id) ? "space_name" : "subdomain",
						handle_space_sucess
					);
				} else {
					if (status_callback)
						status_callback({
							status: "error",
							message: "Could not load this space.",
							load_status: "error",
							detail: "NOT_FOUND"
						});
				}
			}

			function predict(
				endpoint: string,
				data: unknown[],
				event_data?: unknown
			): Promise<unknown> {
				let data_returned = false;
				let status_complete = false;
				let dependency;
				if (typeof endpoint === "number") {
					dependency = config.dependencies[endpoint];
				} else {
					const trimmed_endpoint = endpoint.replace(/^\//, "");
					dependency = config.dependencies[api_map[trimmed_endpoint]];
				}

				if (dependency.types.continuous) {
					throw new Error(
						"Cannot call predict on this function as it may run forever. Use submit instead"
					);
				}

				return new Promise((res, rej) => {
					const app = submit(endpoint, data, event_data);
					let result;

					app
						.on("data", (d) => {
							// if complete message comes before data, resolve here
							if (status_complete) {
								app.destroy();
								res(d);
							}
							data_returned = true;
							result = d;
						})
						.on("status", (status) => {
							if (status.stage === "error") rej(status);
							if (status.stage === "complete") {
								status_complete = true;
								// if complete message comes after data, resolve here
								if (data_returned) {
									app.destroy();
									res(result);
								}
							}
						});
				});
			}

			function submit(
				endpoint: string | number,
				data: unknown[],
				event_data?: unknown,
				trigger_id: number | null = null
			): SubmitReturn {
				let fn_index: number;
				let api_info;

				if (typeof endpoint === "number") {
					fn_index = endpoint;
					api_info = api.unnamed_endpoints[fn_index];
				} else {
					const trimmed_endpoint = endpoint.replace(/^\//, "");

					fn_index = api_map[trimmed_endpoint];
					api_info = api.named_endpoints[endpoint.trim()];
				}

				if (typeof fn_index !== "number") {
					throw new Error(
						"There is no endpoint matching that name of fn_index matching that number."
					);
				}

				let websocket: WebSocket;
				let eventSource: EventSource;
				let protocol = config.protocol ?? "ws";

				const _endpoint = typeof endpoint === "number" ? "/predict" : endpoint;
				let payload: Payload;
				let event_id: string | null = null;
				let complete: false | Record<string, any> = false;
				const listener_map: ListenerMap<EventType> = {};
				let url_params = "";
				if (typeof window !== "undefined") {
					url_params = new URLSearchParams(window.location.search).toString();
				}

				handle_blob(`${config.root}`, data, api_info, hf_token).then(
					(_payload) => {
						payload = {
							data: _payload || [],
							event_data,
							fn_index,
							trigger_id
						};
						if (skip_queue(fn_index, config)) {
							fire_event({
								type: "status",
								endpoint: _endpoint,
								stage: "pending",
								queue: false,
								fn_index,
								time: new Date()
							});

							post_data(
								`${config.root}/run${
									_endpoint.startsWith("/") ? _endpoint : `/${_endpoint}`
								}${url_params ? "?" + url_params : ""}`,
								{
									...payload,
									session_hash
								},
								hf_token
							)
								.then(([output, status_code]) => {
									const data = output.data;
									if (status_code == 200) {
										fire_event({
											type: "data",
											endpoint: _endpoint,
											fn_index,
											data: data,
											time: new Date()
										});

										fire_event({
											type: "status",
											endpoint: _endpoint,
											fn_index,
											stage: "complete",
											eta: output.average_duration,
											queue: false,
											time: new Date()
										});
									} else {
										fire_event({
											type: "status",
											stage: "error",
											endpoint: _endpoint,
											fn_index,
											message: output.error,
											queue: false,
											time: new Date()
										});
									}
								})
								.catch((e) => {
									fire_event({
										type: "status",
										stage: "error",
										message: e.message,
										endpoint: _endpoint,
										fn_index,
										queue: false,
										time: new Date()
									});
								});
						} else if (protocol == "ws") {
							fire_event({
								type: "status",
								stage: "pending",
								queue: true,
								endpoint: _endpoint,
								fn_index,
								time: new Date()
							});
							let url = new URL(`${ws_protocol}://${resolve_root(
								host,
								config.path,
								true
							)}
							/queue/join${url_params ? "?" + url_params : ""}`);

							if (jwt) {
								url.searchParams.set("__sign", jwt);
							}

							websocket = new WebSocket(url);

							websocket.onclose = (evt) => {
								if (!evt.wasClean) {
									fire_event({
										type: "status",
										stage: "error",
										broken: true,
										message: BROKEN_CONNECTION_MSG,
										queue: true,
										endpoint: _endpoint,
										fn_index,
										time: new Date()
									});
								}
							};

							websocket.onmessage = function (event) {
								const _data = JSON.parse(event.data);
								const { type, status, data } = handle_message(
									_data,
									last_status[fn_index]
								);

								if (type === "update" && status && !complete) {
									// call 'status' listeners
									fire_event({
										type: "status",
										endpoint: _endpoint,
										fn_index,
										time: new Date(),
										...status
									});
									if (status.stage === "error") {
										websocket.close();
									}
								} else if (type === "hash") {
									websocket.send(JSON.stringify({ fn_index, session_hash }));
									return;
								} else if (type === "data") {
									websocket.send(JSON.stringify({ ...payload, session_hash }));
								} else if (type === "complete") {
									complete = status;
								} else if (type === "log") {
									fire_event({
										type: "log",
										log: data.log,
										level: data.level,
										endpoint: _endpoint,
										fn_index
									});
								} else if (type === "generating") {
									fire_event({
										type: "status",
										time: new Date(),
										...status,
										stage: status?.stage!,
										queue: true,
										endpoint: _endpoint,
										fn_index
									});
								}
								if (data) {
									fire_event({
										type: "data",
										time: new Date(),
										data: data.data,
										endpoint: _endpoint,
										fn_index
									});

									if (complete) {
										fire_event({
											type: "status",
											time: new Date(),
											...complete,
											stage: status?.stage!,
											queue: true,
											endpoint: _endpoint,
											fn_index
										});
										websocket.close();
									}
								}
							};

							// different ws contract for gradio versions older than 3.6.0
							//@ts-ignore
							if (semiver(config.version || "2.0.0", "3.6") < 0) {
								addEventListener("open", () =>
									websocket.send(JSON.stringify({ hash: session_hash }))
								);
							}
						} else if (protocol == "sse") {
							fire_event({
								type: "status",
								stage: "pending",
								queue: true,
								endpoint: _endpoint,
								fn_index,
								time: new Date()
							});
							var params = new URLSearchParams({
								fn_index: fn_index.toString(),
								session_hash: session_hash
							}).toString();
							let url = new URL(
								`${config.root}/queue/join?${
									url_params ? url_params + "&" : ""
								}${params}`
							);

							eventSource = EventSource_factory(url);

							eventSource.onmessage = async function (event) {
								const _data = JSON.parse(event.data);
								const { type, status, data } = handle_message(
									_data,
									last_status[fn_index]
								);

								if (type === "update" && status && !complete) {
									// call 'status' listeners
									fire_event({
										type: "status",
										endpoint: _endpoint,
										fn_index,
										time: new Date(),
										...status
									});
									if (status.stage === "error") {
										eventSource.close();
									}
								} else if (type === "data") {
									event_id = _data.event_id as string;
									let [_, status] = await post_data(
										`${config.root}/queue/data`,
										{
											...payload,
											session_hash,
											event_id
										},
										hf_token
									);
									if (status !== 200) {
										fire_event({
											type: "status",
											stage: "error",
											message: BROKEN_CONNECTION_MSG,
											queue: true,
											endpoint: _endpoint,
											fn_index,
											time: new Date()
										});
										eventSource.close();
									}
								} else if (type === "complete") {
									complete = status;
								} else if (type === "log") {
									fire_event({
										type: "log",
										log: data.log,
										level: data.level,
										endpoint: _endpoint,
										fn_index
									});
								} else if (type === "generating") {
									fire_event({
										type: "status",
										time: new Date(),
										...status,
										stage: status?.stage!,
										queue: true,
										endpoint: _endpoint,
										fn_index
									});
								}
								if (data) {
									fire_event({
										type: "data",
										time: new Date(),
										data: data.data,
										endpoint: _endpoint,
										fn_index
									});

									if (complete) {
										fire_event({
											type: "status",
											time: new Date(),
											...complete,
											stage: status?.stage!,
											queue: true,
											endpoint: _endpoint,
											fn_index
										});
										eventSource.close();
									}
								}
							};
						} else if (protocol == "sse_v1" || protocol == "sse_v2") {
							// latest API format. v2 introduces sending diffs for intermediate outputs in generative functions, which makes payloads lighter.
							fire_event({
								type: "status",
								stage: "pending",
								queue: true,
								endpoint: _endpoint,
								fn_index,
								time: new Date()
							});

							post_data(
								`${config.root}/queue/join?${url_params}`,
								{
									...payload,
									session_hash
								},
								hf_token
							).then(([response, status]) => {
								if (status === 503) {
									fire_event({
										type: "status",
										stage: "error",
										message: QUEUE_FULL_MSG,
										queue: true,
										endpoint: _endpoint,
										fn_index,
										time: new Date()
									});
								} else if (status !== 200) {
									fire_event({
										type: "status",
										stage: "error",
										message: BROKEN_CONNECTION_MSG,
										queue: true,
										endpoint: _endpoint,
										fn_index,
										time: new Date()
									});
								} else {
									event_id = response.event_id as string;
									let callback = async function (_data: object): void {
										try {
											const { type, status, data } = handle_message(
												_data,
												last_status[fn_index]
											);

											if (type == "heartbeat") {
												return;
											}

											if (type === "update" && status && !complete) {
												// call 'status' listeners
												fire_event({
													type: "status",
													endpoint: _endpoint,
													fn_index,
													time: new Date(),
													...status
												});
											} else if (type === "complete") {
												complete = status;
											} else if (type == "unexpected_error") {
												console.error("Unexpected error", status?.message);
												fire_event({
													type: "status",
													stage: "error",
													message:
														status?.message || "An Unexpected Error Occurred!",
													queue: true,
													endpoint: _endpoint,
													fn_index,
													time: new Date()
												});
											} else if (type === "log") {
												fire_event({
													type: "log",
													log: data.log,
													level: data.level,
													endpoint: _endpoint,
													fn_index
												});
												return;
											} else if (type === "generating") {
												fire_event({
													type: "status",
													time: new Date(),
													...status,
													stage: status?.stage!,
													queue: true,
													endpoint: _endpoint,
													fn_index
												});
												if (data && protocol === "sse_v2") {
													apply_diff_stream(event_id!, data);
												}
											}
											if (data) {
												fire_event({
													type: "data",
													time: new Date(),
													data: data.data,
													endpoint: _endpoint,
													fn_index
												});

												if (complete) {
													fire_event({
														type: "status",
														time: new Date(),
														...complete,
														stage: status?.stage!,
														queue: true,
														endpoint: _endpoint,
														fn_index
													});
												}
											}

											if (
												status?.stage === "complete" ||
												status?.stage === "error"
											) {
												if (event_callbacks[event_id]) {
													delete event_callbacks[event_id];
												}
												if (event_id in pending_diff_streams) {
													delete pending_diff_streams[event_id];
												}
											}
										} catch (e) {
											console.error("Unexpected client exception", e);
											fire_event({
												type: "status",
												stage: "error",
												message: "An Unexpected Error Occurred!",
												queue: true,
												endpoint: _endpoint,
												fn_index,
												time: new Date()
											});
											close_stream();
										}
									};
									if (event_id in pending_stream_messages) {
										pending_stream_messages[event_id].forEach((msg) =>
											callback(msg)
										);
										delete pending_stream_messages[event_id];
									}
									event_callbacks[event_id] = callback;
									unclosed_events.add(event_id);
									if (!stream_open) {
										open_stream();
									}
								}
							});
						}
					}
				);

				function apply_diff_stream(event_id: string, data: any): void {
					let is_first_generation = !pending_diff_streams[event_id];
					if (is_first_generation) {
						pending_diff_streams[event_id] = [];
						data.data.forEach((value: any, i: number) => {
							pending_diff_streams[event_id][i] = value;
						});
					} else {
						data.data.forEach((value: any, i: number) => {
							let new_data = apply_diff(
								pending_diff_streams[event_id][i],
								value
							);
							pending_diff_streams[event_id][i] = new_data;
							data.data[i] = new_data;
						});
					}
				}

				function fire_event<K extends EventType>(event: Event<K>): void {
					const narrowed_listener_map: ListenerMap<K> = listener_map;
					const listeners = narrowed_listener_map[event.type] || [];
					listeners?.forEach((l) => l(event));
				}

				function on<K extends EventType>(
					eventType: K,
					listener: EventListener<K>
				): SubmitReturn {
					const narrowed_listener_map: ListenerMap<K> = listener_map;
					const listeners = narrowed_listener_map[eventType] || [];
					narrowed_listener_map[eventType] = listeners;
					listeners?.push(listener);

					return { on, off, cancel, destroy };
				}

				function off<K extends EventType>(
					eventType: K,
					listener: EventListener<K>
				): SubmitReturn {
					const narrowed_listener_map: ListenerMap<K> = listener_map;
					let listeners = narrowed_listener_map[eventType] || [];
					listeners = listeners?.filter((l) => l !== listener);
					narrowed_listener_map[eventType] = listeners;

					return { on, off, cancel, destroy };
				}

				async function cancel(): Promise<void> {
					const _status: Status = {
						stage: "complete",
						queue: false,
						time: new Date()
					};
					complete = _status;
					fire_event({
						..._status,
						type: "status",
						endpoint: _endpoint,
						fn_index: fn_index
					});

					let cancel_request = {};
					if (protocol === "ws") {
						if (websocket && websocket.readyState === 0) {
							websocket.addEventListener("open", () => {
								websocket.close();
							});
						} else {
							websocket.close();
						}
						cancel_request = { fn_index, session_hash };
					} else {
						eventSource.close();
						cancel_request = { event_id };
					}

					try {
						await fetch_implementation(`${config.root}/reset`, {
							headers: { "Content-Type": "application/json" },
							method: "POST",
							body: JSON.stringify(cancel_request)
						});
					} catch (e) {
						console.warn(
							"The `/reset` endpoint could not be called. Subsequent endpoint results may be unreliable."
						);
					}
				}

				function destroy(): void {
					for (const event_type in listener_map) {
						listener_map[event_type as "data" | "status"].forEach((fn) => {
							off(event_type as "data" | "status", fn);
						});
					}
				}

				return {
					on,
					off,
					cancel,
					destroy
				};
			}

			function open_stream(): void {
				stream_open = true;
				let params = new URLSearchParams({
					session_hash: session_hash
				}).toString();
				let url = new URL(`${config.root}/queue/data?${params}`);
				event_stream = EventSource_factory(url);
				event_stream.onmessage = async function (event) {
					let _data = JSON.parse(event.data);
					const event_id = _data.event_id;
					if (!event_id) {
						await Promise.all(
							Object.keys(event_callbacks).map((event_id) =>
								event_callbacks[event_id](_data)
							)
						);
					} else if (event_callbacks[event_id]) {
						if (_data.msg === "process_completed") {
							unclosed_events.delete(event_id);
							if (unclosed_events.size === 0) {
								close_stream();
							}
						}
						let fn = event_callbacks[event_id];
						window.setTimeout(fn, 0, _data); // need to do this to put the event on the end of the event loop, so the browser can refresh between callbacks and not freeze in case of quick generations. See https://github.com/gradio-app/gradio/pull/7055
					} else {
						if (!pending_stream_messages[event_id]) {
							pending_stream_messages[event_id] = [];
						}
						pending_stream_messages[event_id].push(_data);
					}
				};
				event_stream.onerror = async function (event) {
					await Promise.all(
						Object.keys(event_callbacks).map((event_id) =>
							event_callbacks[event_id]({
								msg: "unexpected_error",
								message: BROKEN_CONNECTION_MSG
							})
						)
					);
					close_stream();
				};
			}

			function close_stream(): void {
				stream_open = false;
				event_stream?.close();
			}

			async function component_server(
				component_id: number,
				fn_name: string,
				data: unknown[]
			): Promise<any> {
				const headers: {
					Authorization?: string;
					"Content-Type": "application/json";
				} = { "Content-Type": "application/json" };
				if (hf_token) {
					headers.Authorization = `Bearer ${hf_token}`;
				}
				let root_url: string;
				let component = config.components.find(
					(comp) => comp.id === component_id
				);
				if (component?.props?.root_url) {
					root_url = component.props.root_url;
				} else {
					root_url = config.root;
				}
				const response = await fetch_implementation(
					`${root_url}/component_server/`,
					{
						method: "POST",
						body: JSON.stringify({
							data: data,
							component_id: component_id,
							fn_name: fn_name,
							session_hash: session_hash
						}),
						headers
					}
				);

				if (!response.ok) {
					throw new Error(
						"Could not connect to component server: " + response.statusText
					);
				}

				const output = await response.json();
				return output;
			}

			async function view_api(config?: Config): Promise<ApiInfo<JsApiData>> {
				if (api) return api;

				const headers: {
					Authorization?: string;
					"Content-Type": "application/json";
				} = { "Content-Type": "application/json" };
				if (hf_token) {
					headers.Authorization = `Bearer ${hf_token}`;
				}
				let response: Response;
				// @ts-ignore
				if (semiver(config.version || "2.0.0", "3.30") < 0) {
					response = await fetch_implementation(
						"https://gradio-space-api-fetcher-v2.hf.space/api",
						{
							method: "POST",
							body: JSON.stringify({
								serialize: false,
								config: JSON.stringify(config)
							}),
							headers
						}
					);
				} else {
					response = await fetch_implementation(`${config.root}/info`, {
						headers
					});
				}

				if (!response.ok) {
					throw new Error(BROKEN_CONNECTION_MSG);
				}

				let api_info = (await response.json()) as
					| ApiInfo<ApiData>
					| { api: ApiInfo<ApiData> };
				if ("api" in api_info) {
					api_info = api_info.api;
				}

				if (
					api_info.named_endpoints["/predict"] &&
					!api_info.unnamed_endpoints["0"]
				) {
					api_info.unnamed_endpoints[0] = api_info.named_endpoints["/predict"];
				}

				const x = transform_api_info(api_info, config, api_map);
				return x;
			}
		});
	}

	async function handle_blob(
		endpoint: string,
		data: unknown[],
		api_info: ApiInfo<JsApiData>,
		token?: `hf_${string}`
	): Promise<unknown[]> {
		const blob_refs = await walk_and_store_blobs(
			data,
			undefined,
			[],
			true,
			api_info
		);

		return Promise.all(
			blob_refs.map(async ({ path, blob, type }) => {
				if (blob) {
					const file_url = (await upload_files(endpoint, [blob], token))
						.files[0];
					return { path, file_url, type, name: blob?.name };
				}
				return { path, type };
			})
		).then((r) => {
			r.forEach(({ path, file_url, type, name }) => {
				if (type === "Gallery") {
					update_object(data, file_url, path);
				} else if (file_url) {
					const file = new FileData({ path: file_url, orig_name: name });
					update_object(data, file, path);
				}
			});

			return data;
		});
	}
}

export const { post_data, upload_files, client, handle_blob } = api_factory(
	fetch,
	(...args) => new EventSource(...args)
);

interface ApiData {
	label: string;
	type: {
		type: any;
		description: string;
	};
	component: string;
	example_input?: any;
}

interface JsApiData {
	label: string;
	type: string;
	component: string;
	example_input: any;
}

interface EndpointInfo<T extends ApiData | JsApiData> {
	parameters: T[];
	returns: T[];
}
interface ApiInfo<T extends ApiData | JsApiData> {
	named_endpoints: {
		[key: string]: EndpointInfo<T>;
	};
	unnamed_endpoints: {
		[key: string]: EndpointInfo<T>;
	};
}

function get_type(
	type: { [key: string]: any },
	component: string,
	serializer: string,
	signature_type: "return" | "parameter"
): string {
	switch (type.type) {
		case "string":
			return "string";
		case "boolean":
			return "boolean";
		case "number":
			return "number";
	}

	if (
		serializer === "JSONSerializable" ||
		serializer === "StringSerializable"
	) {
		return "any";
	} else if (serializer === "ListStringSerializable") {
		return "string[]";
	} else if (component === "Image") {
		return signature_type === "parameter" ? "Blob | File | Buffer" : "string";
	} else if (serializer === "FileSerializable") {
		if (type?.type === "array") {
			return signature_type === "parameter"
				? "(Blob | File | Buffer)[]"
				: `{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}[]`;
		}
		return signature_type === "parameter"
			? "Blob | File | Buffer"
			: `{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}`;
	} else if (serializer === "GallerySerializable") {
		return signature_type === "parameter"
			? "[(Blob | File | Buffer), (string | null)][]"
			: `[{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}, (string | null))][]`;
	}
}

function get_description(
	type: { type: any; description: string },
	serializer: string
): string {
	if (serializer === "GallerySerializable") {
		return "array of [file, label] tuples";
	} else if (serializer === "ListStringSerializable") {
		return "array of strings";
	} else if (serializer === "FileSerializable") {
		return "array of files or single file";
	}
	return type.description;
}

function transform_api_info(
	api_info: ApiInfo<ApiData>,
	config: Config,
	api_map: Record<string, number>
): ApiInfo<JsApiData> {
	const new_data = {
		named_endpoints: {},
		unnamed_endpoints: {}
	};
	for (const key in api_info) {
		const cat = api_info[key];

		for (const endpoint in cat) {
			const dep_index = config.dependencies[endpoint]
				? endpoint
				: api_map[endpoint.replace("/", "")];

			const info = cat[endpoint];
			new_data[key][endpoint] = {};
			new_data[key][endpoint].parameters = {};
			new_data[key][endpoint].returns = {};
			new_data[key][endpoint].type = config.dependencies[dep_index].types;
			new_data[key][endpoint].parameters = info.parameters.map(
				({ label, component, type, serializer }) => ({
					label,
					component,
					type: get_type(type, component, serializer, "parameter"),
					description: get_description(type, serializer)
				})
			);

			new_data[key][endpoint].returns = info.returns.map(
				({ label, component, type, serializer }) => ({
					label,
					component,
					type: get_type(type, component, serializer, "return"),
					description: get_description(type, serializer)
				})
			);
		}
	}

	return new_data;
}

async function get_jwt(
	space: string,
	token: `hf_${string}`
): Promise<string | false> {
	try {
		const r = await fetch(`https://huggingface.co/api/spaces/${space}/jwt`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		const jwt = (await r.json()).token;

		return jwt || false;
	} catch (e) {
		console.error(e);
		return false;
	}
}

function update_object(object, newValue, stack): void {
	while (stack.length > 1) {
		object = object[stack.shift()];
	}

	object[stack.shift()] = newValue;
}

export async function walk_and_store_blobs(
	param,
	type = undefined,
	path = [],
	root = false,
	api_info = undefined
): Promise<
	{
		path: string[];
		type: string;
		blob: Blob | false;
	}[]
> {
	if (Array.isArray(param)) {
		let blob_refs = [];

		await Promise.all(
			param.map(async (v, i) => {
				let new_path = path.slice();
				new_path.push(i);

				const array_refs = await walk_and_store_blobs(
					param[i],
					root ? api_info?.parameters[i]?.component || undefined : type,
					new_path,
					false,
					api_info
				);

				blob_refs = blob_refs.concat(array_refs);
			})
		);

		return blob_refs;
	} else if (globalThis.Buffer && param instanceof globalThis.Buffer) {
		const is_image = type === "Image";
		return [
			{
				path: path,
				blob: is_image ? false : new NodeBlob([param]),
				type
			}
		];
	} else if (typeof param === "object") {
		let blob_refs = [];
		for (let key in param) {
			if (param.hasOwnProperty(key)) {
				let new_path = path.slice();
				new_path.push(key);
				blob_refs = blob_refs.concat(
					await walk_and_store_blobs(
						param[key],
						undefined,
						new_path,
						false,
						api_info
					)
				);
			}
		}
		return blob_refs;
	}
	return [];
}

function image_to_data_uri(blob: Blob): Promise<string | ArrayBuffer> {
	return new Promise((resolve, _) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result);
		reader.readAsDataURL(blob);
	});
}

function skip_queue(id: number, config: Config): boolean {
	return (
		!(config?.dependencies?.[id]?.queue === null
			? config.enable_queue
			: config?.dependencies?.[id]?.queue) || false
	);
}

async function resolve_config(
	fetch_implementation: typeof fetch,
	endpoint?: string,
	token?: `hf_${string}`
): Promise<Config> {
	const headers: { Authorization?: string } = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (
		typeof window !== "undefined" &&
		window.gradio_config &&
		location.origin !== "http://localhost:9876" &&
		!window.gradio_config.dev_mode
	) {
		const path = window.gradio_config.root;
		const config = window.gradio_config;
		config.root = resolve_root(endpoint, config.root, false);
		return { ...config, path: path };
	} else if (endpoint) {
		let response = await fetch_implementation(`${endpoint}/config`, {
			headers
		});

		if (response.status === 200) {
			const config = await response.json();
			config.path = config.path ?? "";
			config.root = endpoint;
			return config;
		}
		throw new Error("Could not get config.");
	}

	throw new Error("No config or app endpoint found");
}

async function check_space_status(
	id: string,
	type: "subdomain" | "space_name",
	status_callback: SpaceStatusCallback
): Promise<void> {
	let endpoint =
		type === "subdomain"
			? `https://huggingface.co/api/spaces/by-subdomain/${id}`
			: `https://huggingface.co/api/spaces/${id}`;
	let response;
	let _status;
	try {
		response = await fetch(endpoint);
		_status = response.status;
		if (_status !== 200) {
			throw new Error();
		}
		response = await response.json();
	} catch (e) {
		status_callback({
			status: "error",
			load_status: "error",
			message: "Could not get space status",
			detail: "NOT_FOUND"
		});
		return;
	}

	if (!response || _status !== 200) return;
	const {
		runtime: { stage },
		id: space_name
	} = response;

	switch (stage) {
		case "STOPPED":
		case "SLEEPING":
			status_callback({
				status: "sleeping",
				load_status: "pending",
				message: "Space is asleep. Waking it up...",
				detail: stage
			});

			setTimeout(() => {
				check_space_status(id, type, status_callback);
			}, 1000); // poll for status
			break;
		case "PAUSED":
			status_callback({
				status: "paused",
				load_status: "error",
				message:
					"This space has been paused by the author. If you would like to try this demo, consider duplicating the space.",
				detail: stage,
				discussions_enabled: await discussions_enabled(space_name)
			});
			break;
		case "RUNNING":
		case "RUNNING_BUILDING":
			status_callback({
				status: "running",
				load_status: "complete",
				message: "",
				detail: stage
			});
			// load_config(source);
			//  launch
			break;
		case "BUILDING":
			status_callback({
				status: "building",
				load_status: "pending",
				message: "Space is building...",
				detail: stage
			});

			setTimeout(() => {
				check_space_status(id, type, status_callback);
			}, 1000);
			break;
		default:
			status_callback({
				status: "space_error",
				load_status: "error",
				message: "This space is experiencing an issue.",
				detail: stage,
				discussions_enabled: await discussions_enabled(space_name)
			});
			break;
	}
}

function handle_message(
	data: any,
	last_status: Status["stage"]
): {
	type: "hash" | "data" | "update" | "complete" | "generating" | "log" | "none";
	data?: any;
	status?: Status;
} {
	const queue = true;
	switch (data.msg) {
		case "send_data":
			return { type: "data" };
		case "send_hash":
			return { type: "hash" };
		case "queue_full":
			return {
				type: "update",
				status: {
					queue,
					message: QUEUE_FULL_MSG,
					stage: "error",
					code: data.code,
					success: data.success
				}
			};
		case "heartbeat":
			return {
				type: "heartbeat"
			};
		case "unexpected_error":
			return {
				type: "unexpected_error",
				status: {
					queue,
					message: data.message,
					stage: "error",
					success: false
				}
			};
		case "estimation":
			return {
				type: "update",
				status: {
					queue,
					stage: last_status || "pending",
					code: data.code,
					size: data.queue_size,
					position: data.rank,
					eta: data.rank_eta,
					success: data.success
				}
			};
		case "progress":
			return {
				type: "update",
				status: {
					queue,
					stage: "pending",
					code: data.code,
					progress_data: data.progress_data,
					success: data.success
				}
			};
		case "log":
			return { type: "log", data: data };
		case "process_generating":
			return {
				type: "generating",
				status: {
					queue,
					message: !data.success ? data.output.error : null,
					stage: data.success ? "generating" : "error",
					code: data.code,
					progress_data: data.progress_data,
					eta: data.average_duration
				},
				data: data.success ? data.output : null
			};
		case "process_completed":
			if ("error" in data.output) {
				return {
					type: "update",
					status: {
						queue,
						message: data.output.error as string,
						stage: "error",
						code: data.code,
						success: data.success
					}
				};
			}
			return {
				type: "complete",
				status: {
					queue,
					message: !data.success ? data.output.error : undefined,
					stage: data.success ? "complete" : "error",
					code: data.code,
					progress_data: data.progress_data
				},
				data: data.success ? data.output : null
			};

		case "process_starts":
			return {
				type: "update",
				status: {
					queue,
					stage: "pending",
					code: data.code,
					size: data.rank,
					position: 0,
					success: data.success,
					eta: data.eta
				}
			};
	}

	return { type: "none", status: { stage: "error", queue } };
}
