#!/usr/bin/env node
process.title = "mmdc"
import commander from 'commander'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer'

import pkg from './package.json'

const error = message => {
  console.log(chalk.red(`\n${message}\n`))
  process.exit(1)
}

const checkConfigFile = file => {
  if (!fs.existsSync(file)) {
    error(`Configuration file "${file}" doesn't exist`)
  }
}

const inputPipedFromStdin = () => fs.fstatSync(0).isFIFO()

const getInputData = async inputFile => new Promise((resolve, reject) => {
  // if an input file has been specified using '-i', it takes precedence over
  // piping from stdin
  if (typeof inputFile !== 'undefined') {
    return fs.readFile(inputFile, 'utf-8', (err, data) => {
      if (err) {
        return reject(err)
      }

      return resolve(data)
    })
  }

  let data = ''
  process.stdin.on('readable', function () {
    var chunk = this.read()

    if (chunk !== null) {
      data += chunk
    }
  })

  process.stdin.on('error', function (err) {
    reject(err)
  })

  process.stdin.on('end', function () {
    resolve(data)
  })
})

const convertToValidXML = html => {
  // <br> tags in valid HTML (from innerHTML) look like <br>, but they must look like <br/> to be valid XML (such as SVG)
  return html.replace(/<br>/gi, '<br/>')
}

commander
  .version(pkg.version)
  .option('-t, --theme [theme]', 'Theme of the chart, could be default, forest, dark or neutral. Optional. Default: default', /^default|forest|dark|neutral$/, 'default')
  .option('-w, --width [width]', 'Width of the page. Optional. Default: 800', /^\d+$/, '800')
  .option('-H, --height [height]', 'Height of the page. Optional. Default: 600', /^\d+$/, '600')
  .option('-i, --input <input>', 'Input mermaid file. Files ending in .md will be treated as Markdown and all charts (e.g. ```mermaid (...)```) will be extracted and generated. Required.')
  .option('-o, --output [output]', 'Output file. It should be either svg, png or pdf. Optional. Default: input + ".svg"')
  .option('-b, --backgroundColor [backgroundColor]', 'Background color. Example: transparent, red, \'#F0F0F0\'. Optional. Default: white')
  .option('-c, --configFile [configFile]', 'JSON configuration file for mermaid. Optional')
  .option('-C, --cssFile [cssFile]', 'CSS file for the page. Optional')
  .option('-s, --scale [scale]', 'Puppeteer scale factor, default 1. Optional')
  .option('-f, --pdfFit [pdfFit]', 'Scale PDF to fit chart')
  .option('-q, --quiet', 'Suppress log output')
  .option('-p --puppeteerConfigFile [puppeteerConfigFile]', 'JSON configuration file for puppeteer. Optional')
  .parse(process.argv)

const options = commander.opts();

let { theme, width, height, input, output, backgroundColor, configFile, cssFile, puppeteerConfigFile, scale, pdfFit, quiet } = options

// check input file
if (!(input || inputPipedFromStdin())) {
  console.log(chalk.red(`\nPlease specify input file: -i <input>\n`))
  commander.help()
  process.exit(1)
}
if (input && !fs.existsSync(input)) {
  error(`Input file "${input}" doesn't exist`)
}

// check output file
if (!output) {
  // if an input file is defined, it should take precedence, otherwise, input is
  // coming from stdin and just name the file out.svg, if it hasn't been
  // specified with the '-o' option
  output = input ? (input + '.svg') : 'out.svg'
}
if (!/\.(?:svg|png|pdf)$/.test(output)) {
  error(`Output file must end with ".svg", ".png" or ".pdf"`)
}
const outputDir = path.dirname(output)
if (!fs.existsSync(outputDir)) {
  error(`Output directory "${outputDir}/" doesn't exist`)
}

// check config files
let mermaidConfig = { theme }
if (configFile) {
  checkConfigFile(configFile)
  mermaidConfig = Object.assign(mermaidConfig, JSON.parse(fs.readFileSync(configFile, 'utf-8')))
}
let puppeteerConfig = {}
if (puppeteerConfigFile) {
  checkConfigFile(puppeteerConfigFile)
  puppeteerConfig = JSON.parse(fs.readFileSync(puppeteerConfigFile, 'utf-8'))
}

// check cssFile
let myCSS
if (cssFile) {
  if (!fs.existsSync(cssFile)) {
    error(`CSS file "${cssFile}" doesn't exist`)
  }
  myCSS = fs.readFileSync(cssFile, 'utf-8')
}

const info = message => {
  if (!quiet) {
    console.info(message)
  }
}

// normalize args
width = parseInt(width)
height = parseInt(height)
backgroundColor = backgroundColor || 'white';
const deviceScaleFactor = parseInt(scale || 1, 10);

const parseMMD = async (browser, definition, output) => {
  const page = await browser.newPage()
  page.setViewport({ width, height, deviceScaleFactor })
  await page.goto(`file://${path.join(__dirname, 'index.html')}`)
  await page.evaluate(`document.body.style.background = '${backgroundColor}'`)
  const result = await page.$eval('#container', (container, definition, mermaidConfig, myCSS) => {
    container.textContent = definition
    window.mermaid.initialize(mermaidConfig)
    if (myCSS) {
      const head = window.document.head || window.document.getElementsByTagName('head')[0]
      const style = document.createElement('style')
      style.type = 'text/css'
      if (style.styleSheet) {
        style.styleSheet.cssText = myCSS
      } else {
        style.appendChild(document.createTextNode(myCSS))
      }
      head.appendChild(style)
    }

    try {
      window.mermaid.init(undefined, container)
      return { status: 'success' };
    } catch (error) {
      return { status: 'error', error, message: error.message };
    }
  }, definition, mermaidConfig, myCSS)
  if (result.status === 'error') {
    error(result.message);
  }

  if (output.endsWith('svg')) {
    const svg = await page.$eval('#container', container => container.innerHTML)
    const svg_xml = convertToValidXML(svg)
    fs.writeFileSync(output, svg_xml)
  } else if (output.endsWith('png')) {
    const clip = await page.$eval('svg', svg => {
      const react = svg.getBoundingClientRect()
      return { x: Math.floor(react.left), y: Math.floor(react.top), width: Math.ceil(react.width), height: Math.ceil(react.height) }
    })
    await page.setViewport({ width: clip.x + clip.width, height: clip.y + clip.height, deviceScaleFactor })
    await page.screenshot({ path: output, clip, omitBackground: backgroundColor === 'transparent' })
  } else { // pdf
    if (pdfFit) {
      const clip = await page.$eval('svg', svg => {
        const react = svg.getBoundingClientRect()
        return { x: react.left, y: react.top, width: react.width, height: react.height }
      })
      await page.pdf({
        path: output,
        printBackground: backgroundColor !== 'transparent',
        width: (Math.ceil(clip.width) + clip.x*2) + 'px',
        height: (Math.ceil(clip.height) + clip.y*2) + 'px',
        pageRanges: '1-1',
      })
    } else {
      await page.pdf({
        path: output,
        printBackground: backgroundColor !== 'transparent'
      })
    }
  }
}

(async () => {
  const mermaidChartsInMarkdown = '^```(?:mermaid)(\r?\n([\\s\\S]*?))```$';
  const mermaidChartsInMarkdownReg = new RegExp(mermaidChartsInMarkdown, 'gm')
  const browser = await puppeteer.launch(puppeteerConfig)
  const definition = await getInputData(input)
  if (/\.md$/.test(input)) {
    const matches = definition.match(mermaidChartsInMarkdownReg);

    if (matches !== null) {
      info(`Found ${matches.length} mermaid charts in Markdown input`);
      const mmdStrings = matches.map((str) => str.replace(mermaidChartsInMarkdownReg, '$1').trim());
      await Promise.all(mmdStrings.map((mmdString, index) => {
          const output_file = output.replace(/(\..*)$/,`-${index + 1}$1`);
          info(` - ${output_file}`);
          return parseMMD(browser, mmdString, output_file);
        })
      );
    } else {
      info(`No mermaid charts found in Markdown input`);
    }
  } else {
    info(`Generating single mermaid chart`);
    await parseMMD(browser, definition, output);
  }
  await browser.close()
})()
