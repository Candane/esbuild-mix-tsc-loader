import fs from 'fs';
import path from 'path';
import { transform as defaultEsbuildTransform } from 'esbuild';
import { getOptions } from 'loader-utils';
import webpack from 'webpack';
import JoyCon, { LoadResult } from 'joycon';
import JSON5 from 'json5';
import typescript, { TranspileOptions } from 'typescript';
import stripComments from 'strip-comments';
import { LoaderOptions } from './interfaces';

const joycon = new JoyCon();

joycon.addLoader({
	test: /\.json$/,
	async load(filePath) {
		try {
			const config = fs.readFileSync(filePath, 'utf8');
			return JSON5.parse(config);
		} catch (error: any) {
			throw new Error(
				`Failed to parse tsconfig at ${path.relative(
					process.cwd(),
					filePath,
				)}: ${error.message as string}`,
			);
		}
	},
});

const isTsExtensionPtrn = /\.ts$/i;
const isDecorators = /\s@\w+/;
const isImport = /\sfrom\s+['"](.*)['"]/g;
const isDynamicImport = /\s(?:import|require)\s*\(['"](.*)['"]\)/g;
const isImportString = /['"]/;

let tsConfig: LoadResult;

function importModules(source: string, modules: Array<string>): boolean {
	if (!Array.isArray(modules) || modules.length <= 0) { return false; }
	const matchImport = source.match(isImport) ?? [];
	const matchDynamicImport = source.match(isDynamicImport) ?? [];
	if (matchImport.length > 0) {
		for (const importString of matchImport) {
			const splitString = importString.match(isImportString)[0];
			const pack = importString.split(splitString)[1];
			if (modules.includes(pack)) {
				return true;
			}
		}
	}
	if (matchDynamicImport.length > 0) {
		for (const importString of matchDynamicImport) {
			const splitString = importString.match(isImportString)[0];
			const pack = importString.split(splitString)[1];
			if (modules.includes(pack)) {
				return true;
			}
		}
	}

	return false;
}

async function ESBuildLoader(
	this: webpack.loader.LoaderContext,
	source: string,
): Promise<void> {
	const done = this.async();
	const options: LoaderOptions = getOptions(this);
	const {
		implementation,
		emitDecoratorMetadata,
		modules,
		...esbuildTransformOptions
	} = options;

	if (implementation && typeof implementation.transform !== 'function') {
		done(
			new TypeError(
				`esbuild-loader: options.implementation.transform must be an ESBuild transform function. Received ${typeof implementation.transform}`,
			),
		);
		return;
	}

	const transform = implementation?.transform ?? defaultEsbuildTransform;

	const transformOptions = {
		...esbuildTransformOptions,
		target: options.target ?? 'es2015',
		loader: options.loader ?? 'js',
		sourcemap: this.sourceMap,
		sourcefile: this.resourcePath,
	};

	if (!('tsconfigRaw' in transformOptions)) {
		if (!tsConfig) {
			tsConfig = await joycon.load(['tsconfig.json']);
		}

		if (tsConfig.data) {
			transformOptions.tsconfigRaw = tsConfig.data;
		}
	}

	// https://github.com/privatenumber/esbuild-loader/pull/107
	if (
		transformOptions.loader === 'tsx'
		&& isTsExtensionPtrn.test(this.resourcePath)
	) {
		transformOptions.loader = 'ts';
	}

	if (
		(emitDecoratorMetadata
			&& isDecorators.test(stripComments(source)))
		|| (modules && importModules(source, modules))
	) {
		try {
			const { outputText, sourceMapText } = typescript.transpileModule(
				source,
				tsConfig as TranspileOptions,
			);
			done(null, outputText, sourceMapText);
		} catch (error: unknown) {
			done(error as Error);
		}
	} else {
		try {
			const { code, map } = await transform(source, transformOptions);
			done(null, code, map && JSON.parse(map));
		} catch (error: unknown) {
			done(error as Error);
		}
	}
}

export default ESBuildLoader;
