import path from 'path';
import { getFileSystem, llms } from '#agent/agentContext';
import { FileSystem } from '#functions/filesystem';
import { logger } from '#o11y/logger';
import { CompileErrorAnalysis, analyzeCompileErrors } from '#swe/analyzeCompileErrors';
import { execCommand } from '#utils/exec';
import { cacheRetry } from '../cache/cacheRetry';
import { func, funcClass } from '../functionDefinition/functionDecorators';
import { CodeEditor } from './codeEditor';
import { ProjectInfo, detectProjectInfo } from './projectDetection';
import { basePrompt } from './prompt';
import { SelectFilesResponse, selectFilesToEdit } from './selectFilesToEdit';
import { summariseRequirements } from './summariseRequirements';

export function buildPrompt(args: {
	information: string;
	requirements: string;
	action: string;
}): string {
	return `${basePrompt}\n${args.information}\n\nThe requirements of the task are as follows:\n<requirements>\n${args.requirements}\n</requirements>\n\nThe action to be performed is as follows:\n<action>\n${args.action}\n</action>\n`;
}

@funcClass(__filename)
export class CodeEditingAgent {
	//* @param projectInfo details of the project, lang/runtime etc
	/**
	 * Runs a workflow which edits the code repository to implement the requirements, and committing changes to version control.
	 * It also compiles, formats, lints, and runs tests where applicable.
	 * @param requirements The requirements to implement including support documentation and code samples.
	 */
	@func()
	async runCodeEditWorkflow(requirements: string, projectInfo?: ProjectInfo) {
		if (!projectInfo) {
			const detected: ProjectInfo[] = await detectProjectInfo();
			if (detected.length !== 1) throw new Error('projectInfo array must have one item');
			projectInfo = detected[0];
		}

		const fileSystem: FileSystem = getFileSystem();
		const projectPath = path.join(fileSystem.getWorkingDirectory(), projectInfo.baseDir);
		fileSystem.setWorkingDirectory(projectInfo.baseDir);

		const filesResponse: SelectFilesResponse = await this.selectFilesToEdit(requirements, projectInfo);
		const initialSelectedFiles: string[] = [
			...filesResponse.primaryFiles.map((selected) => selected.path),
			...filesResponse.secondaryFiles.map((selected) => selected.path),
		];

		const implementationRequirements = await llms().hard.generateText(
			`${await fileSystem.getMultipleFileContentsAsXml(initialSelectedFiles)}
		<requirements>${requirements}</requirements>
		You are a senior software engineer. Your job is to review the provided user requirements against the code provided and produce an implementation design specification to give to a junior developer to implement the changes in the provided files.
		Do not provide any details of verification commands etc as the CI/CD build will run integration tests. Only detail the changes required in the files for the pull request.
		Check if any of the requirements have already been correctly implemented in the code as to not duplicate work.
		Look at the existing style of the code when producing the requirements.
		`,
			null,
			{ id: 'implementationSpecification' },
		);

		logger.info(`projectPath ${projectPath}`);
		logger.info(initialSelectedFiles, 'Initial selected files');

		let errorAnalysis: CompileErrorAnalysis = null;
		let compileErrorOutput = null;

		const MAX_ATTEMPTS = 2;
		let e: any;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			try {
				const files: string[] = [...initialSelectedFiles];
				let editRequirements = implementationRequirements;

				if (errorAnalysis) editRequirements += `\nImmediate task: Fix the following compile errors:\n${compileErrorOutput}`;
				if (errorAnalysis?.additionalFiles) files.push(...errorAnalysis.additionalFiles);
				if (errorAnalysis.installPackages) {
					for (const packageName of errorAnalysis.installPackages) {
						await projectInfo.languageTools?.installPackage(packageName);
					}
				}

				// Make sure the project compiles first
				if (i === 0) await this.compile(projectInfo);

				await new CodeEditor().editFilesToMeetRequirements(editRequirements, files);

				const newFiles: string[] = await fileSystem.vcs.getFilesAddedInHeadCommit();
				initialSelectedFiles.push(...newFiles);
				files.push(...newFiles);
				// TODO get any new files added in the last commit and add to initialSelectedFiles
				await this.compile(projectInfo);
				errorAnalysis = null;
				break;
			} catch (e) {
				// TODO If compiling fails after Aider edit, we could add in the diff from the files with compile errors
				compileErrorOutput = e.message;
				logger.error(`Compile Error Output: ${compileErrorOutput}`);
				// TODO handle code editor error separately - what failure modes does it have (invalid args, git error etc)?
				errorAnalysis = await analyzeCompileErrors(compileErrorOutput, initialSelectedFiles);
			}
		}

		if (errorAnalysis) return;

		if (projectInfo.staticAnalysis) {
			const STATIC_ANALYSIS_MAX_ATTEMPTS = 2;
			for (let i = 0; i < STATIC_ANALYSIS_MAX_ATTEMPTS; i++) {
				// Run it twice so the first time can apply any auto-fixes, then the second time has only the non-auto fixable issues
				try {
					await this.runStaticAnalysis(projectInfo);
					await fileSystem.vcs.addAllTrackedAndCommit('Fix static analysis errors');
					break;
				} catch (e) {
					// Commit any successful auto-fixes
					await fileSystem.vcs.addAllTrackedAndCommit('Fix static analysis errors');
					if (i === STATIC_ANALYSIS_MAX_ATTEMPTS - 1) {
						logger.warn(`Unable to fix static analysis errors: ${compileErrorOutput}`);
					} else {
						const staticErrorFiles = await this.extractFilenames(`${compileErrorOutput}\n\nExtract the filenames from the compile errors.`);
						await new CodeEditor().editFilesToMeetRequirements(
							`Static analysis command: ${projectInfo.staticAnalysis}\n${compileErrorOutput}\nFix these static analysis errors`,
							staticErrorFiles,
						);
					}
				}
			}
		}

		await this.testLoop(requirements, projectInfo, initialSelectedFiles, projectPath);
	}

	async compile(projectInfo: ProjectInfo): Promise<void> {
		// Execute the command `npm run lint` with the working directory as projectPath using the standard node library and return the exit code, standard output and error output.
		// if (stat(projectRoots + '/' + projectPath).isDirectory()) {
		// 	console.log('Directory')
		// }
		logger.debug(getFileSystem().getWorkingDirectory(), projectInfo.compile);
		const { exitCode, stdout, stderr } = await execCommand(projectInfo.compile, getFileSystem().getWorkingDirectory());
		const result = `<compile_output>
	<command>${projectInfo.compile}</command>
	<stdout>
	${stdout}
	</stdout>
	<stderr>
	${stderr}
	</stderr>
</compile_output>`;
		// console.log('exit code', exitCode);
		if (exitCode > 0) {
			logger.info(stdout);
			logger.error(stderr);
			throw new Error(result);
		}
	}

	@cacheRetry()
	async selectFilesToEdit(requirements: string, projectInfo: ProjectInfo): Promise<SelectFilesResponse> {
		return await selectFilesToEdit(requirements, projectInfo);
	}

	async runStaticAnalysis(projectInfo: ProjectInfo): Promise<void> {
		if (!projectInfo.staticAnalysis) return;
		const { exitCode, stdout, stderr } = await execCommand(projectInfo.staticAnalysis);
		const result = `<static_analysis_output><command>${projectInfo.compile}</command><stdout></stdout>${stdout}<stderr>${stderr}</stderr></static_analysis_output>`;
		if (exitCode > 0) {
			throw new Error(result);
		}
	}

	async runTests(projectInfo: ProjectInfo): Promise<void> {
		if (!projectInfo.test) return;
		const { exitCode, stdout, stderr } = await execCommand(projectInfo.test);
		const result = `<test_output><command>${projectInfo.test}</command><stdout></stdout>${stdout}<stderr>${stderr}</stderr></test_output>`;
		if (exitCode > 0) {
			throw new Error(result);
		}
	}

	async testLoop(requirements: string, projectInfo: ProjectInfo, initialSelectedFiles: string[], projectPath: string): Promise<CompileErrorAnalysis | null> {
		if (!projectInfo.test) return null;
		let testErrorOutput = null;
		let errorAnalysis: CompileErrorAnalysis = null;
		const MAX_ATTEMPTS = 2;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			try {
				let testRequirements = `${requirements}\nSome of the requirements may have already been implemented, so don't duplicate any existing implementation meeting the requirements.\n`;
				testRequirements += 'Write any additional tests that would be of value.';
				await new CodeEditor().editFilesToMeetRequirements(testRequirements, initialSelectedFiles);
				await this.compile(projectInfo);
				await this.runTests(projectInfo);
				errorAnalysis = null;
				break;
			} catch (e) {
				testErrorOutput = e.message;
				logger.info(`Test error output: ${testErrorOutput}`);
				errorAnalysis = await analyzeCompileErrors(testErrorOutput, initialSelectedFiles);
			}
		}
		return errorAnalysis;
	}

	@cacheRetry()
	// @func()
	async summariseRequirements(requirements: string): Promise<string> {
		return summariseRequirements(requirements);
	}

	@cacheRetry()
	async extractFilenames(summary: string): Promise<string[]> {
		const filenames = await getFileSystem().listFilesRecursively();
		const prompt = buildPrompt({
			information: `<project_files>\n${filenames.join('\n')}\n</project_files>`,
			requirements: summary,
			action:
				'You will respond ONLY in JSON. From the requirements quietly consider which the files may be required to complete the task. You MUST output your answer ONLY as JSON in the format of this example:\n<example>\n{\n files: ["file1", "file2", "file3"]\n}\n</example>',
		});
		const response = await llms().hard.generateTextAsJson(prompt, null, { id: 'extractFilenames' });
		return response.files;
	}
}
