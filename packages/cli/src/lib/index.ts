import fs from 'fs'
import path from 'path'

import lodash from 'lodash'
import camelcase from 'camelcase'
import pascalcase from 'pascalcase'
import pluralize from 'pluralize'
import decamelize from 'decamelize'
import { paramCase } from 'param-case'
import { getDMMF } from '@prisma/sdk'
import { getPaths as getRedwoodPaths } from '@redwoodjs/internal'
import execa from 'execa'
import Listr from 'listr'
import VerboseRenderer from 'listr-verbose-renderer'
import { format } from 'prettier'
import * as babel from '@babel/core'

import c from './colors'

export const asyncForEach = async (array: any[], callback: Function) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

export const readFile = (target: Parameters<typeof fs['readFileSync']>[0]) =>
  fs.readFileSync(target)

/**
 * This wraps the core version of getPaths into something that catches the exception
 * and displays a helpful error message.
 */
export const getPaths = () => {
  try {
    return getRedwoodPaths()
  } catch (e) {
    console.error(c.error(e.message))
    process.exit(0)
  }
}

/*
 * Returns the DMMF defined by `prisma` resolving the relevant `shema.prisma` path.
 */
export const getSchemaDefinitions = async () => {
  const schemaPath = path.join(getPaths().api.db, 'schema.prisma')
  const metadata = await getDMMF({
    datamodel: readFile(schemaPath).toString(),
  })

  return metadata
}

/**
 * This returns the config present in `prettier.config.js` of a Redwood project.
 */
export const prettierOptions = () => {
  try {
    return require(path.join(getPaths().base, 'prettier.config.js'))
  } catch (e) {
    return undefined
  }
}

/**
 * Returns the database schema for the given `name` database table parsed from
 * the schema.prisma of the target application. If no `name` is given then the
 * entire schema is returned.
 */
export const getSchema = async (name: string) => {
  const schema = await getSchemaDefinitions()

  if (name) {
    const model = schema.datamodel.models.find((model) => {
      return model.name === name
    })

    if (model) {
      return model
    } else {
      throw new Error(
        `No schema definition found for \`${name}\` in schema.prisma file`
      )
    }
  }

  return schema.metadata.datamodel
}

/**
 * Returns the enum defined with the given `name` parsed from
 * the schema.prisma of the target application. If no `name` is given then the
 * all enum definitions are returned
 */
export const getEnum = async (name: string) => {
  const schema = await getSchemaDefinitions()

  if (name) {
    const model = schema.datamodel.enums.find((model) => {
      return model.name === name
    })

    if (model) {
      return model
    } else {
      throw new Error(
        `No enum schema definition found for \`${name}\` in schema.prisma file`
      )
    }
  }

  return schema.metadata.datamodel.enums
}

/**
 * Returns variants of the passed `name` for usage in templates. If the given
 * name was "fooBar" then these would be:

 * pascalName: FooBar
 * singularPascalName: FooBar
 * pluralPascalName: FooBars
 * singularCamelName: fooBar
 * pluralCamelName: fooBars
 * singularParamName: foo-bar
 * pluralParamName: foo-bars
 * singularConstantName: FOO_BAR
 * pluralConstantName: FOO_BARS
*/
export const nameVariants = (name: string) => {
  const normalizedName = pascalcase(paramCase(pluralize.singular(name)))

  return {
    pascalName: pascalcase(name),
    camelName: camelcase(name),
    singularPascalName: normalizedName,
    pluralPascalName: pluralize(normalizedName),
    singularCamelName: camelcase(normalizedName),
    pluralCamelName: camelcase(pluralize(normalizedName)),
    singularParamName: paramCase(normalizedName),
    pluralParamName: paramCase(pluralize(normalizedName)),
    singularConstantName: decamelize(normalizedName).toUpperCase(),
    pluralConstantName: decamelize(pluralize(normalizedName)).toUpperCase(),
  }
}

export const templateRoot = path.resolve(__dirname, '../commands/generate')

export const prettify = (
  templateFilename: string,
  renderedTemplate: string
) => {
  // We format .js and .css templates, we need to tell prettier which parser
  // we're using.
  // https://prettier.io/docs/en/options.html#parser
  const parser = {
    '.css': 'css',
    '.js': 'babel',
    '.ts': 'babel-ts',
  }[path.extname(templateFilename.replace('.template', '')) as '.css' | '.js']

  if (typeof parser === 'undefined') {
    return renderedTemplate
  }

  return format(renderedTemplate, {
    ...prettierOptions(),
    parser,
  })
}

export const generateTemplate = (
  templateFilename: string,
  { name, root, ...rest }: { [key: string]: any }
) => {
  const templatePath = path.join(root || templateRoot, templateFilename)
  const template = lodash.template(readFile(templatePath).toString())

  const renderedTemplate = template({
    name,
    ...nameVariants(name),
    ...rest,
  })

  return prettify(templateFilename, renderedTemplate)
}

const SUPPORTED_EXTENSIONS = ['.js', '.ts', '.tsx']

const getBaseFile = (file: string) => file.replace(/\.\w*$/, '')

export const deleteFile = (file: string) => {
  const extension = path.extname(file)
  if (SUPPORTED_EXTENSIONS.includes(extension)) {
    const baseFile = getBaseFile(file)
    SUPPORTED_EXTENSIONS.forEach((ext) => {
      const f = baseFile + ext
      if (fs.existsSync(f)) {
        fs.unlinkSync(f)
      }
    })
  } else {
    fs.unlinkSync(file)
  }
}

const existsAnyExtensionSync = (file: string) => {
  const extension = path.extname(file)
  if (SUPPORTED_EXTENSIONS.includes(extension)) {
    const baseFile = getBaseFile(file)
    return SUPPORTED_EXTENSIONS.some((ext) => fs.existsSync(baseFile + ext))
  }

  return fs.existsSync(file)
}

export const writeFile = (
  target: string,
  contents: string | object,
  { overwriteExisting = false } = {}
) => {
  if (!overwriteExisting && fs.existsSync(target)) {
    throw new Error(`${target} already exists.`)
  }

  const filename = path.basename(target)
  const targetDir = target.replace(filename, '')
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(target, contents)
}

export const bytes = (contents: Parameters<typeof Buffer['byteLength']>[0]) =>
  Buffer.byteLength(contents, 'utf8')

// TODO: Move this into `generateTemplate` when all templates have TS support
/*
 * Convert a generated TS template file into JS.
 */
export const transformTSToJS = (filename: string, content: string) => {
  const result = babel.transform(content, {
    filename,
    configFile: false,
    plugins: [
      [
        '@babel/plugin-transform-typescript',
        {
          isTSX: true,
          allExtensions: true,
        },
      ],
    ],
    retainLines: true,
  })?.code

  return prettify(filename.replace(/\.ts$/, '.js'), result)
}

/**
 * Creates a list of tasks that write files to the disk.
 *
 * @param files - {[filepath]: contents}
 */
export const writeFilesTask = (
  files: { [filepath: string]: string },
  options: { overwriteExisting: boolean }
) => {
  const { base } = getPaths()
  return new Listr(
    Object.keys(files).map((file) => {
      const contents = files[file]
      return {
        title: `Writing \`./${path.relative(base, file)}\`...`,
        task: () => writeFile(file, contents, options),
      }
    })
  )
}

/**
 * @param files - {[filepath]: contents}
 */
export const cleanupEmptyDirsTask = (files: object) => {
  const { base } = getPaths()
  const allDirs = Object.keys(files).map((file) => path.dirname(file))
  const uniqueDirs = [...new Set(allDirs)]
  return new Listr(
    uniqueDirs.map((dir) => {
      return {
        title: `Removing empty \`./${path.relative(base, dir)}\`...`,
        task: () => fs.rmdirSync(dir),
        skip: () => {
          if (!fs.existsSync(dir)) {
            return `Doesn't exist`
          }
          if (fs.readdirSync(dir).length > 0) {
            return 'Not empty'
          }
          return false
        },
      }
    })
  )
}

/**
 * Creates a list of tasks that delete files from the disk.
 *
 * @param files - {[filepath]: contents}
 */
export const deleteFilesTask = (files: object) => {
  const { base } = getPaths()

  return new Listr([
    ...Object.keys(files).map((file) => {
      return {
        title: `Destroying \`./${path.relative(base, getBaseFile(file))}\`...`,
        skip: () => !existsAnyExtensionSync(file) && `File doesn't exist`,
        task: () => deleteFile(file),
      }
    }),
    {
      title: 'Cleaning up empty directories...',
      task: () => cleanupEmptyDirsTask(files),
    },
  ])
}

/**
 * Update the project's routes file.
 */
export const addRoutesToRouterTask = (routes: string[]) => {
  const redwoodPaths = getPaths()
  const routesContent = readFile(redwoodPaths.web.routes).toString()
  const newRoutesContent = routes.reverse().reduce((content, route) => {
    if (content.includes(route)) {
      return content
    }
    return content.replace(/(\s*)\<Router\>/, `$1<Router>$1  ${route}`)
  }, routesContent)
  writeFile(redwoodPaths.web.routes, newRoutesContent, {
    overwriteExisting: true,
  })
}

/**
 * Remove named routes from the project's routes file.
 *
 * @param {string[]} routes - Route names
 */
export const removeRoutesFromRouterTask = (routes: string[]) => {
  const redwoodPaths = getPaths()
  const routesContent = readFile(redwoodPaths.web.routes).toString()
  const newRoutesContent = routes.reduce((content, route) => {
    const matchRouteByName = new RegExp(`\\s*<Route[^>]*name="${route}"[^>]*/>`)
    return content.replace(matchRouteByName, '')
  }, routesContent)

  writeFile(redwoodPaths.web.routes, newRoutesContent, {
    overwriteExisting: true,
  })
}

export const runCommandTask = async (
  commands: {
    title: string
    cmd: string
    args: string[]
    opts: execa.Options
  }[],
  { verbose }: { verbose: boolean }
) => {
  const tasks = new Listr(
    commands.map(({ title, cmd, args, opts = {} }) => ({
      title,
      task: async () => {
        return execa(cmd, args, {
          shell: true,
          cwd: `${getPaths().base}/api`,
          stdio: verbose ? 'inherit' : 'pipe',
          extendEnv: true,
          cleanup: true,
          ...opts,
        })
      },
    })),
    {
      renderer: verbose && VerboseRenderer,
      // @ts-ignore TODO dateFormat comes from listr-verbose-renderer
      dateFormat: false,
    }
  )

  try {
    await tasks.run()
    return true
  } catch (e) {
    console.log(c.error(e.message))
    return false
  }
}

/*
 * Extract default CLI args from an exported builder
 */
export const getDefaultArgs = (builder: object) => {
  return Object.entries(builder).reduce((agg, [k, v]) => {
    agg[k] = v.default
    return agg
  }, {} as { [key: string]: any })
}