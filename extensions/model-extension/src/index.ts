import {
  fs,
  downloadFile,
  abortDownload,
  InferenceEngine,
  joinPath,
  ModelExtension,
  Model,
  getJanDataFolderPath,
  events,
  DownloadEvent,
  DownloadRoute,
  DownloadState,
  OptionType,
  ImportingModel,
  LocalImportModelEvent,
  baseName,
  GpuSetting,
  DownloadRequest,
  executeOnMain,
  HuggingFaceRepoData,
  getFileSize,
  AllQuantizations,
  ModelEvent,
  ModelFile,
  dirName,
} from '@janhq/core'

import { extractFileName } from './helpers/path'
import { GGUFMetadata, gguf } from '@huggingface/gguf'
import { NotSupportedModelError } from './@types/NotSupportModelError'
import { InvalidHostError } from './@types/InvalidHostError'

declare const SETTINGS: Array<any>
enum Settings {
  huggingFaceAccessToken = 'hugging-face-access-token',
}

/**
 * A extension for models
 */
export default class JanModelExtension extends ModelExtension {
  private static readonly _homeDir = 'file://models'
  private static readonly _modelMetadataFileName = 'model.json'
  private static readonly _supportedModelFormat = '.gguf'
  private static readonly _incompletedModelFileName = '.download'
  private static readonly _offlineInferenceEngine = [
    InferenceEngine.nitro,
    InferenceEngine.nitro_tensorrt_llm,
  ]
  private static readonly _tensorRtEngineFormat = '.engine'
  private static readonly _supportedGpuArch = ['ampere', 'ada']

  interrupted = false

  /**
   * Called when the extension is loaded.
   * @override
   */
  async onLoad() {
    // Handle Desktop Events
    this.registerSettings(SETTINGS)
    this.handleDesktopEvents()
  }

  /**
   * Called when the extension is unloaded.
   * @override
   */
  async onUnload() {}

  /**
   * Downloads a machine learning model.
   * @param model - The model to download.
   * @param network - Optional object to specify proxy/whether to ignore SSL certificates.
   * @returns A Promise that resolves when the model is downloaded.
   */
  async downloadModel(
    model: ModelFile,
    gpuSettings?: GpuSetting,
    network?: { ignoreSSL?: boolean; proxy?: string }
  ): Promise<void> {
    // Create corresponding directory
    const modelDirPath = await joinPath([JanModelExtension._homeDir, model.id])
    if (!(await fs.existsSync(modelDirPath))) await fs.mkdir(modelDirPath)
    const modelJsonPath =
      model.file_path ?? (await joinPath([modelDirPath, 'model.json']))

    // Download HF model - model.json not exist
    if (!(await fs.existsSync(modelJsonPath))) {
      // It supports only one source for HF download
      const metadata = await this.fetchModelMetadata(model.sources[0].url)
      const updatedModel = await this.retrieveGGUFMetadata(metadata)
      if (updatedModel) {
        // Update model settings
        model.settings = {
          ...model.settings,
          ...updatedModel.settings,
        }
        model.parameters = {
          ...model.parameters,
          ...updatedModel.parameters,
        }
      }
      await fs.writeFileSync(modelJsonPath, JSON.stringify(model, null, 2))
      events.emit(ModelEvent.OnModelsUpdate, {})
    }
    if (model.engine === InferenceEngine.nitro_tensorrt_llm) {
      if (!gpuSettings || gpuSettings.gpus.length === 0) {
        console.error('No GPU found. Please check your GPU setting.')
        return
      }
      const firstGpu = gpuSettings.gpus[0]
      if (!firstGpu.name.toLowerCase().includes('nvidia')) {
        console.error('No Nvidia GPU found. Please check your GPU setting.')
        return
      }
      const gpuArch = firstGpu.arch
      if (gpuArch === undefined) {
        console.error(
          'No GPU architecture found. Please check your GPU setting.'
        )
        return
      }

      if (!JanModelExtension._supportedGpuArch.includes(gpuArch)) {
        console.debug(
          `Your GPU: ${JSON.stringify(firstGpu)} is not supported. Only 30xx, 40xx series are supported.`
        )
        return
      }

      const os = 'windows' // TODO: remove this hard coded value

      const newSources = model.sources.map((source) => {
        const newSource = { ...source }
        newSource.url = newSource.url
          .replace(/<os>/g, os)
          .replace(/<gpuarch>/g, gpuArch)
        return newSource
      })
      model.sources = newSources
    }

    console.debug(`Download sources: ${JSON.stringify(model.sources)}`)

    if (model.sources.length > 1) {
      // path to model binaries
      for (const source of model.sources) {
        let path = extractFileName(
          source.url,
          JanModelExtension._supportedModelFormat
        )
        if (source.filename) {
          path = model.file_path
            ? await joinPath([await dirName(model.file_path), source.filename])
            : await joinPath([modelDirPath, source.filename])
        }

        const downloadRequest: DownloadRequest = {
          url: source.url,
          localPath: path,
          modelId: model.id,
        }
        downloadFile(downloadRequest, network)
      }
      // TODO: handle multiple binaries for web later
    } else {
      const fileName = extractFileName(
        model.sources[0]?.url,
        JanModelExtension._supportedModelFormat
      )
      const path = model.file_path
        ? await joinPath([await dirName(model.file_path), fileName])
        : await joinPath([modelDirPath, fileName])
      const downloadRequest: DownloadRequest = {
        url: model.sources[0]?.url,
        localPath: path,
        modelId: model.id,
      }
      downloadFile(downloadRequest, network)

      if (window && window.core?.api && window.core.api.baseApiUrl) {
        this.startPollingDownloadProgress(model.id)
      }
    }
  }

  private toHuggingFaceUrl(repoId: string): string {
    try {
      const url = new URL(repoId)
      if (url.host !== 'huggingface.co') {
        throw new InvalidHostError(`Invalid Hugging Face repo URL: ${repoId}`)
      }

      const paths = url.pathname.split('/').filter((e) => e.trim().length > 0)
      if (paths.length < 2) {
        throw new InvalidHostError(`Invalid Hugging Face repo URL: ${repoId}`)
      }

      return `${url.origin}/api/models/${paths[0]}/${paths[1]}`
    } catch (err) {
      if (err instanceof InvalidHostError) {
        throw err
      }

      if (repoId.startsWith('https')) {
        throw new Error(`Cannot parse url: ${repoId}`)
      }

      return `https://huggingface.co/api/models/${repoId}`
    }
  }

  async fetchHuggingFaceRepoData(repoId: string): Promise<HuggingFaceRepoData> {
    const sanitizedUrl = this.toHuggingFaceUrl(repoId)
    console.debug('sanitizedUrl', sanitizedUrl)

    const huggingFaceAccessToken = (
      await this.getSetting<string>(Settings.huggingFaceAccessToken, '')
    ).trim()

    const headers = {
      Accept: 'application/json',
    }

    if (huggingFaceAccessToken.length > 0) {
      headers['Authorization'] = `Bearer ${huggingFaceAccessToken}`
    }

    const res = await fetch(sanitizedUrl, {
      headers: headers,
    })
    const response = await res.json()
    if (response['error'] != null) {
      throw new Error(response['error'])
    }

    const data = response as HuggingFaceRepoData

    if (data.tags.indexOf('gguf') === -1) {
      throw new NotSupportedModelError(
        `${repoId} is not supported. Only GGUF models are supported.`
      )
    }

    const promises: Promise<number>[] = []

    // fetching file sizes
    const url = new URL(sanitizedUrl)
    const paths = url.pathname.split('/').filter((e) => e.trim().length > 0)

    for (const sibling of data.siblings) {
      const downloadUrl = `https://huggingface.co/${paths[2]}/${paths[3]}/resolve/main/${sibling.rfilename}`
      sibling.downloadUrl = downloadUrl
      promises.push(getFileSize(downloadUrl))
    }

    const result = await Promise.all(promises)
    for (let i = 0; i < data.siblings.length; i++) {
      data.siblings[i].fileSize = result[i]
    }

    AllQuantizations.forEach((quantization) => {
      data.siblings.forEach((sibling) => {
        if (!sibling.quantization && sibling.rfilename.includes(quantization)) {
          sibling.quantization = quantization
        }
      })
    })

    data.modelUrl = `https://huggingface.co/${paths[2]}/${paths[3]}`
    return data
  }

  async fetchModelMetadata(url: string): Promise<GGUFMetadata> {
    const { metadata } = await gguf(url)
    return metadata
  }

  /**
   * Specifically for Jan server.
   */
  private async startPollingDownloadProgress(modelId: string): Promise<void> {
    // wait for some seconds before polling
    await new Promise((resolve) => setTimeout(resolve, 3000))

    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        fetch(
          `${window.core.api.baseApiUrl}/v1/download/${DownloadRoute.getDownloadProgress}/${modelId}`,
          {
            method: 'GET',
            headers: { contentType: 'application/json' },
          }
        ).then(async (res) => {
          const state: DownloadState = await res.json()
          if (state.downloadState === 'end') {
            events.emit(DownloadEvent.onFileDownloadSuccess, state)
            clearInterval(interval)
            resolve()
            return
          }

          if (state.downloadState === 'error') {
            events.emit(DownloadEvent.onFileDownloadError, state)
            clearInterval(interval)
            resolve()
            return
          }

          events.emit(DownloadEvent.onFileDownloadUpdate, state)
        })
      }, 1000)
    })
  }

  /**
   * Cancels the download of a specific machine learning model.
   *
   * @param {string} modelId - The ID of the model whose download is to be cancelled.
   * @returns {Promise<void>} A promise that resolves when the download has been cancelled.
   */
  async cancelModelDownload(modelId: string): Promise<void> {
    const path = await joinPath([JanModelExtension._homeDir, modelId, modelId])
    try {
      await abortDownload(path)
      await fs.unlinkSync(path)
    } catch (e) {
      console.error(e)
    }
  }

  /**
   * Deletes a machine learning model.
   * @param filePath - The path to the model file to delete.
   * @returns A Promise that resolves when the model is deleted.
   */
  async deleteModel(model: ModelFile): Promise<void> {
    try {
      const dirPath = await dirName(model.file_path)
      const jsonFilePath = await joinPath([
        dirPath,
        JanModelExtension._modelMetadataFileName,
      ])
      const modelInfo = JSON.parse(
        await this.readModelMetadata(jsonFilePath)
      ) as Model

      // TODO: This is so tricky?
      // Should depend on sources?
      const isUserImportModel =
        modelInfo.metadata?.author?.toLowerCase() === 'user'
      if (isUserImportModel) {
        // just delete the folder
        return fs.rm(dirPath)
      }

      // remove all files under dirPath except model.json
      const files = await fs.readdirSync(dirPath)
      const deletePromises = files.map(async (fileName: string) => {
        if (fileName !== JanModelExtension._modelMetadataFileName) {
          return fs.unlinkSync(await joinPath([dirPath, fileName]))
        }
      })
      await Promise.allSettled(deletePromises)
    } catch (err) {
      console.error(err)
    }
  }

  /**
   * Gets all downloaded models.
   * @returns A Promise that resolves with an array of all models.
   */
  async getDownloadedModels(): Promise<ModelFile[]> {
    return await this.getModelsMetadata(
      async (modelDir: string, model: Model) => {
        if (!JanModelExtension._offlineInferenceEngine.includes(model.engine))
          return true

        // model binaries (sources) are absolute path & exist
        const existFiles = await Promise.all(
          model.sources.map(
            (source) =>
              // Supposed to be a local file url
              !source.url.startsWith(`http://`) &&
              !source.url.startsWith(`https://`)
          )
        )
        if (existFiles.every((exist) => exist)) return true

        const result = await fs
          .readdirSync(await joinPath([JanModelExtension._homeDir, modelDir]))
          .then((files: string[]) => {
            // Model binary exists in the directory
            // Model binary name can match model ID or be a .gguf file and not be an incompleted model file
            return (
              files.includes(modelDir) ||
              files.filter((file) => {
                if (
                  file.endsWith(JanModelExtension._incompletedModelFileName)
                ) {
                  return false
                }
                return (
                  file
                    .toLowerCase()
                    .includes(JanModelExtension._supportedModelFormat) ||
                  file
                    .toLowerCase()
                    .includes(JanModelExtension._tensorRtEngineFormat)
                )
                // Check if the number of matched files equals the number of sources
              })?.length >= model.sources.length
            )
          })

        return result
      }
    )
  }

  private async getModelJsonPath(
    folderFullPath: string
  ): Promise<string | undefined> {
    // try to find model.json recursively inside each folder
    if (!(await fs.existsSync(folderFullPath))) return undefined

    const files: string[] = await fs.readdirSync(folderFullPath)
    if (files.length === 0) return undefined

    if (files.includes(JanModelExtension._modelMetadataFileName)) {
      return joinPath([
        folderFullPath,
        JanModelExtension._modelMetadataFileName,
      ])
    }
    // continue recursive
    for (const file of files) {
      const path = await joinPath([folderFullPath, file])
      const fileStats = await fs.fileStat(path)
      if (fileStats.isDirectory) {
        const result = await this.getModelJsonPath(path)
        if (result) return result
      }
    }
  }

  private async getModelsMetadata(
    selector?: (path: string, model: Model) => Promise<boolean>
  ): Promise<ModelFile[]> {
    try {
      if (!(await fs.existsSync(JanModelExtension._homeDir))) {
        console.debug('Model folder not found')
        return []
      }

      const files: string[] = await fs.readdirSync(JanModelExtension._homeDir)

      const allDirectories: string[] = []
      for (const file of files) {
        if (file === '.DS_Store') continue
        if (file === 'config') continue
        allDirectories.push(file)
      }

      const readJsonPromises = allDirectories.map(async (dirName) => {
        // filter out directories that don't match the selector
        // read model.json
        const folderFullPath = await joinPath([
          JanModelExtension._homeDir,
          dirName,
        ])

        const jsonPath = await this.getModelJsonPath(folderFullPath)

        if (await fs.existsSync(jsonPath)) {
          // if we have the model.json file, read it
          let model = await this.readModelMetadata(jsonPath)

          model = typeof model === 'object' ? model : JSON.parse(model)

          // This to ensure backward compatibility with `model.json` with `source_url`
          if (model['source_url'] != null) {
            model['sources'] = [
              {
                filename: model.id,
                url: model['source_url'],
              },
            ]
          }
          model.file_path = jsonPath
          model.file_name = JanModelExtension._modelMetadataFileName

          if (selector && !(await selector?.(dirName, model))) {
            return
          }
          return model
        } else {
          // otherwise, we generate our own model file
          // TODO: we might have more than one binary file here. This will be addressed with new version of Model file
          //  which is the PR from Hiro on branch Jan can see
          return this.generateModelMetadata(dirName)
        }
      })
      const results = await Promise.allSettled(readJsonPromises)
      const modelData = results.map((result) => {
        if (result.status === 'fulfilled' && result.value) {
          try {
            const model =
              typeof result.value === 'object'
                ? result.value
                : JSON.parse(result.value)
            return model as ModelFile
          } catch {
            console.debug(`Unable to parse model metadata: ${result.value}`)
          }
        }
        return undefined
      })

      return modelData.filter((e) => !!e)
    } catch (err) {
      console.error(err)
      return []
    }
  }

  private readModelMetadata(path: string) {
    return fs.readFileSync(path, 'utf-8')
  }

  /**
   * Handle the case where we have the model directory but we don't have the corresponding
   * model.json file associated with it.
   *
   * This function will create a model.json file for the model.
   * It works only with single binary file model.
   *
   * @param dirName the director which reside in ~/jan/models but does not have model.json file.
   */
  private async generateModelMetadata(dirName: string): Promise<Model> {
    const files: string[] = await fs.readdirSync(
      await joinPath([JanModelExtension._homeDir, dirName])
    )

    // sort files by name
    files.sort()

    // find the first file which is not a directory
    let binaryFileName: string | undefined = undefined
    let binaryFileSize: number | undefined = undefined

    for (const file of files) {
      if (file.endsWith(JanModelExtension._supportedModelFormat)) {
        const path = await joinPath([JanModelExtension._homeDir, dirName, file])
        const fileStats = await fs.fileStat(path)
        if (fileStats.isDirectory) continue
        binaryFileSize = fileStats.size
        binaryFileName = file
        break
      }
    }

    if (!binaryFileName) {
      console.warn(`Unable to find binary file for model ${dirName}`)
      return
    }

    const defaultModel = (await this.getDefaultModel()) as Model
    const metadata = await executeOnMain(
      NODE,
      'retrieveGGUFMetadata',
      await joinPath([
        await getJanDataFolderPath(),
        'models',
        dirName,
        binaryFileName,
      ])
    ).catch(() => undefined)

    const updatedModel = await this.retrieveGGUFMetadata(metadata)

    if (!defaultModel) {
      console.error('Unable to find default model')
      return
    }

    const model: Model = {
      ...defaultModel,
      // Overwrite default N/A fields
      id: dirName,
      name: dirName,
      sources: [
        {
          url: binaryFileName,
          filename: binaryFileName,
        },
      ],
      parameters: {
        ...defaultModel.parameters,
        ...updatedModel.parameters,
      },
      settings: {
        ...defaultModel.settings,
        ...updatedModel.settings,
        llama_model_path: binaryFileName,
      },
      created: Date.now(),
      description: '',
      metadata: {
        size: binaryFileSize,
        author: 'User',
        tags: [],
      },
    }

    const modelFilePath = await joinPath([
      JanModelExtension._homeDir,
      dirName,
      JanModelExtension._modelMetadataFileName,
    ])

    await fs.writeFileSync(modelFilePath, JSON.stringify(model, null, 2))

    return model
  }

  override async getDefaultModel(): Promise<Model> {
    const defaultModel = DEFAULT_MODEL as Model
    return defaultModel
  }

  /**
   * Gets all available models.
   * @returns A Promise that resolves with an array of all models.
   */
  async getConfiguredModels(): Promise<ModelFile[]> {
    return this.getModelsMetadata()
  }

  handleDesktopEvents() {
    if (window && window.electronAPI) {
      window.electronAPI.onFileDownloadUpdate(
        async (_event: string, state: DownloadState | undefined) => {
          if (!state) return
          state.downloadState = 'downloading'
          events.emit(DownloadEvent.onFileDownloadUpdate, state)
        }
      )
      window.electronAPI.onFileDownloadError(
        async (_event: string, state: DownloadState) => {
          state.downloadState = 'error'
          events.emit(DownloadEvent.onFileDownloadError, state)
        }
      )
      window.electronAPI.onFileDownloadSuccess(
        async (_event: string, state: DownloadState) => {
          state.downloadState = 'end'
          events.emit(DownloadEvent.onFileDownloadSuccess, state)
        }
      )
    }
  }

  private async importModelSymlink(
    modelBinaryPath: string,
    modelFolderName: string,
    modelFolderPath: string
  ): Promise<ModelFile> {
    const fileStats = await fs.fileStat(modelBinaryPath, true)
    const binaryFileSize = fileStats.size

    // Just need to generate model.json there
    const defaultModel = (await this.getDefaultModel()) as Model
    if (!defaultModel) {
      console.error('Unable to find default model')
      return
    }

    const metadata = await executeOnMain(
      NODE,
      'retrieveGGUFMetadata',
      modelBinaryPath
    )

    const binaryFileName = await baseName(modelBinaryPath)
    const updatedModel = await this.retrieveGGUFMetadata(metadata)

    const model: Model = {
      ...defaultModel,
      id: modelFolderName,
      name: modelFolderName,
      sources: [
        {
          url: modelBinaryPath,
          filename: binaryFileName,
        },
      ],
      parameters: {
        ...defaultModel.parameters,
        ...updatedModel.parameters,
      },

      settings: {
        ...defaultModel.settings,
        ...updatedModel.settings,
        llama_model_path: binaryFileName,
      },
      created: Date.now(),
      description: '',
      metadata: {
        size: binaryFileSize,
        author: 'User',
        tags: [],
      },
    }

    const modelFilePath = await joinPath([
      modelFolderPath,
      JanModelExtension._modelMetadataFileName,
    ])

    await fs.writeFileSync(modelFilePath, JSON.stringify(model, null, 2))

    return {
      ...model,
      file_path: modelFilePath,
      file_name: JanModelExtension._modelMetadataFileName,
    }
  }

  async updateModelInfo(modelInfo: Partial<ModelFile>): Promise<ModelFile> {
    if (modelInfo.id == null) throw new Error('Model ID is required')

    const model = JSON.parse(
      await this.readModelMetadata(modelInfo.file_path)
    ) as ModelFile

    const updatedModel: ModelFile = {
      ...model,
      ...modelInfo,
      parameters: {
        ...model.parameters,
        ...modelInfo.parameters,
      },
      settings: {
        ...model.settings,
        ...modelInfo.settings,
      },
      metadata: {
        ...model.metadata,
        ...modelInfo.metadata,
      },
      // Should not persist file_path & file_name
      file_path: undefined,
      file_name: undefined,
    }

    await fs.writeFileSync(
      modelInfo.file_path,
      JSON.stringify(updatedModel, null, 2)
    )
    return updatedModel
  }

  private async importModel(
    model: ImportingModel,
    optionType: OptionType
  ): Promise<Model> {
    const binaryName = (await baseName(model.path)).replace(/\s/g, '')

    let modelFolderName = binaryName
    if (binaryName.endsWith(JanModelExtension._supportedModelFormat)) {
      modelFolderName = binaryName.replace(
        JanModelExtension._supportedModelFormat,
        ''
      )
    }

    const modelFolderPath = await this.getModelFolderName(modelFolderName)
    await fs.mkdir(modelFolderPath)

    const uniqueFolderName = await baseName(modelFolderPath)
    const modelBinaryFile = binaryName.endsWith(
      JanModelExtension._supportedModelFormat
    )
      ? binaryName
      : `${binaryName}${JanModelExtension._supportedModelFormat}`

    const binaryPath = await joinPath([modelFolderPath, modelBinaryFile])

    if (optionType === 'SYMLINK') {
      return this.importModelSymlink(
        model.path,
        uniqueFolderName,
        modelFolderPath
      )
    }

    const srcStat = await fs.fileStat(model.path, true)

    // interval getting the file size to calculate the percentage
    const interval = setInterval(async () => {
      const destStats = await fs.fileStat(binaryPath, true)
      const percentage = destStats.size / srcStat.size
      events.emit(LocalImportModelEvent.onLocalImportModelUpdate, {
        ...model,
        percentage,
      })
    }, 1000)

    await fs.copyFile(model.path, binaryPath)

    clearInterval(interval)

    // generate model json
    return this.generateModelMetadata(uniqueFolderName)
  }

  private async getModelFolderName(
    modelFolderName: string,
    count?: number
  ): Promise<string> {
    const newModelFolderName = count
      ? `${modelFolderName}-${count}`
      : modelFolderName

    const janDataFolderPath = await getJanDataFolderPath()
    const modelFolderPath = await joinPath([
      janDataFolderPath,
      'models',
      newModelFolderName,
    ])

    const isFolderExist = await fs.existsSync(modelFolderPath)
    if (!isFolderExist) {
      return modelFolderPath
    } else {
      const newCount = (count ?? 0) + 1
      return this.getModelFolderName(modelFolderName, newCount)
    }
  }

  async importModels(
    models: ImportingModel[],
    optionType: OptionType
  ): Promise<void> {
    const importedModels: Model[] = []

    for (const model of models) {
      events.emit(LocalImportModelEvent.onLocalImportModelUpdate, model)
      try {
        const importedModel = await this.importModel(model, optionType)
        events.emit(LocalImportModelEvent.onLocalImportModelSuccess, {
          ...model,
          modelId: importedModel.id,
        })
        importedModels.push(importedModel)
      } catch (err) {
        events.emit(LocalImportModelEvent.onLocalImportModelFailed, {
          ...model,
          error: err,
        })
      }
    }

    events.emit(
      LocalImportModelEvent.onLocalImportModelFinished,
      importedModels
    )
  }

  /**
   * Retrieve Model Settings from GGUF Metadata
   * @param metadata
   * @returns
   */
  async retrieveGGUFMetadata(metadata: any): Promise<Partial<Model>> {
    const defaultModel = DEFAULT_MODEL as Model
    var template = await executeOnMain(
      NODE,
      'renderJinjaTemplate',
      metadata
    ).catch(() => undefined)

    const eos_id = metadata['tokenizer.ggml.eos_token_id']
    const architecture = metadata['general.architecture']

    return {
      settings: {
        prompt_template: template ?? defaultModel.settings.prompt_template,
        ctx_len:
          metadata[`${architecture}.context_length`] ??
          metadata['llama.context_length'] ??
          4096,
        ngl:
          (metadata[`${architecture}.block_count`] ??
            metadata['llama.block_count'] ??
            32) + 1,
      },
      parameters: {
        stop: eos_id
          ? [metadata?.['tokenizer.ggml.tokens'][eos_id] ?? '']
          : defaultModel.parameters.stop,
      },
    }
  }
}
