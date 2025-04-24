    #!/usr/bin/env node

    const axios = require('axios');
    const cheerio = require('cheerio');
    const TurndownService = require('turndown');
    const fs = require('fs').promises;
    const path = require('path');
    const { URL } = require('url');
    const { exec } = require('child_process');
    const util = require('util');
    const os = require('os');
    const ignore = require('ignore');
    const yargs = require('yargs/yargs');
    const { hideBin } = require('yargs/helpers');

    const execPromise = util.promisify(exec);

    const OMIT_CONTENT_EXTENSIONS = new Set([
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tif', '.tiff',
        '.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', '.opus',
        '.mp4', '.mov', '.avi', '.wmv', '.mkv', '.flv', '.webm', '.mpeg', '.mpg',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
        '.exe', '.msi', '.bin', '.dll', '.so', '.o', '.a', '.lib', '.class', '.pyc', '.wasm',
        '.zip', '.rar', '.tar', '.gz', '.7z', '.bz2', '.xz', '.iso', '.img',
        '.ttf', '.otf', '.woff', '.woff2', '.eot',
        '.db', '.sqlite', '.mdb', '.jar', '.war', '.swc', '.swf',
        '.obj', '.fbx', '.stl', '.blend', '.glb', '.gltf',
        '.lock', '.log'
    ]);


    const argv = yargs(hideBin(process.argv))
        .usage('Uso: $0 [opciones]')
        .option('url', {
            alias: 'u',
            type: 'string',
            description: 'URL del sitio web a rastrear',
        })
        .option('repo', {
            alias: 'r',
            type: 'string',
            description: 'URL del repositorio Git (HTTPS o SSH) a clonar y procesar',
        })
        .option('dir', {
            alias: 'd',
            type: 'string',
            description: 'Ruta al directorio local a procesar',
        })
        .option('depth', {
            alias: 'l',
            type: 'number',
            default: 1,
            description: 'Profundidad máxima para el rastreo web (Modo URL)',
        })
        .option('output', {
            alias: 'o',
            type: 'string',
            default: 'output.md',
            description: 'Nombre del archivo Markdown de salida',
        })
        .option('branch', {
            alias: 'b',
            type: 'string',
            description: 'Rama específica a clonar (Modo Repo)',
        })
        .option('include-dot-files', {
            type: 'boolean',
            default: false,
            description: 'Incluir archivos/directorios que comienzan con punto (excepto .git y los de .gitignore)',
        })
        .check((argv) => {
            const modes = [argv.url, argv.repo, argv.dir].filter(Boolean).length;
            if (modes === 0) {
                throw new Error('Debe proporcionar una opción: --url, --repo, o --dir');
            }
            if (modes > 1) {
                throw new Error('Proporcione solo una opción: --url, --repo, o --dir');
            }
            return true;
        })
        .help()
        .alias('help', 'h')
        .alias('version', 'v')
        .strict()
        .argv;

    const config = {
        outputFile: argv.output,
        userAgent: 'SmartNodeCrawler/1.0 (contact: your-email@example.com)',
        maxDepth: argv.depth,
        includeDotFiles: argv.includeDotFiles,
        branch: argv.branch,
    };


    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
    });
    let finalMarkdownContent = '';

    function getLanguage(filename) {
        if (typeof filename !== 'string') return '';
        const ext = path.extname(filename).toLowerCase();
        const langMap = {
            '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
            '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.cs': 'csharp',
            '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
            '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml',
            '.md': 'markdown', '.sh': 'shell', '.bash': 'bash', '.ps1': 'powershell',
            '.rb': 'ruby', '.php': 'php', '.go': 'go', '.rs': 'rust', '.sql': 'sql',
            '.swift': 'swift', '.kt': 'kotlin', '.lua': 'lua', '.pl': 'perl',
            '.dockerfile': 'dockerfile', 'dockerfile': 'dockerfile', '.env': 'env',
            '.gitignore': 'gitignore'
        };
        if (!ext && filename.toLowerCase() === 'dockerfile') return 'dockerfile';
        return langMap[ext] || '';
    }

    async function writeOutput(content, filePath) {
        try {
            await fs.writeFile(filePath, content.trim());
            console.log(`\nProceso completado. Contenido guardado en: ${filePath}`);
        } catch (error) {
            console.error(`Error fatal al escribir el archivo de salida ${filePath}:`, error);
        }
    }

    async function executeCommand(command, cwd = null) {
        console.log(`Ejecutando: ${command}` + (cwd ? ` en ${cwd}` : ''));
        try {
            const { stdout, stderr } = await execPromise(command, { cwd, maxBuffer: 1024 * 1024 * 10 });
            if (stderr && !stderr.toLowerCase().includes('cloning into') && !stderr.toLowerCase().includes('already exists')) {
                console.warn(`Stderr de "${command}":\n${stderr}`);
            }
            return { success: true, stdout, stderr };
        } catch (error) {
            console.error(`Error ejecutando "${command}": ${error.message}`);
            console.error(`Stderr: ${error.stderr || '(No stderr)'}`);
            console.error(`Stdout: ${error.stdout || '(No stdout)'}`);
            return { success: false, error };
        }
    }

    const visitedUrls = new Set();
    let webBaseDomain = '';
    let webMarkdownContent = '';

    function normalizeUrl(urlString, baseUrl) {
        try {
            const absoluteUrl = new URL(urlString, baseUrl);
            absoluteUrl.hash = '';
            let href = absoluteUrl.href;
            if (href.length > 1 && href.endsWith('/')) {
                href = href.slice(0, -1);
            }
            return href;
        } catch (error) {
            return null;
        }
    }

    function isSameDomain(urlString) {
        try {
            const currentUrlDomain = new URL(urlString).origin;
            return currentUrlDomain === webBaseDomain;
        } catch (error) {
            return false;
        }
    }

    async function crawlWeb(startUrl, maxDepth) {
        console.log(`Iniciando rastreo web desde: ${startUrl} hasta profundidad ${maxDepth}`);
        const queue = [];

        try {
            const initialUrl = new URL(startUrl);
            webBaseDomain = initialUrl.origin;
            console.log(`Dominio base establecido: ${webBaseDomain}`);

            const normalizedStartUrl = normalizeUrl(startUrl, startUrl);
            if (!normalizedStartUrl) {
                throw new Error("URL inicial inválida.");
            }


            queue.push({ url: normalizedStartUrl, depth: 0 });
            visitedUrls.add(normalizedStartUrl);

            while (queue.length > 0) {
                const { url: currentUrl, depth: currentDepth } = queue.shift();

                console.log(`[Profundidad ${currentDepth}] Procesando Web: ${currentUrl}`);

                try {
                    const response = await axios.get(currentUrl, {
                        headers: { 'User-Agent': config.userAgent },
                        timeout: 15000,
                        validateStatus: status => status >= 200 && status < 400
                    });

                    const contentType = response.headers['content-type'];
                    if (!contentType || !contentType.includes('text/html')) {
                        console.warn(`   -> Contenido no es HTML en ${currentUrl} (${contentType}). Saltando.`);
                        continue;
                    }

                    const htmlContent = response.data;
                    const $ = cheerio.load(htmlContent);

                    $('script, style, noscript, link[rel="stylesheet"], header, footer, nav, aside, form, iframe, button, input, img, video, audio').remove();
                    let mainHtml = $('main').html() || $('article').html() || $('body').html() || $.html();

                    const markdown = turndownService.turndown(mainHtml || '');

                    if (markdown && markdown.trim().length > 0) {
                        webMarkdownContent += `\n\n## Origen URL: ${currentUrl}\n\n${markdown.trim()}\n\n---\n\n`;
                        console.log(`   -> Contenido limpio de ${currentUrl} convertido a Markdown.`);
                    } else {

                    }

                    if (currentDepth < maxDepth) {
                        $('a').each((i, element) => {
                            const href = $(element).attr('href');
                            if (href) {
                                const normalizedLink = normalizeUrl(href, currentUrl);
                                if (normalizedLink &&
                                    !normalizedLink.startsWith('mailto:') &&
                                    !normalizedLink.startsWith('tel:') &&
                                    !normalizedLink.startsWith('javascript:') &&
                                    isSameDomain(normalizedLink) &&
                                    !visitedUrls.has(normalizedLink)
                                ) {
                                    visitedUrls.add(normalizedLink);
                                    queue.push({ url: normalizedLink, depth: currentDepth + 1 });

                                }
                            }
                        });
                    }

                } catch (error) {
                    if (axios.isAxiosError(error)) {
                        let errorMsg = `   -> Error al acceder a ${currentUrl}: ${error.message}`;
                        if (error.response) errorMsg += ` (Status: ${error.response.status})`;
                        if (error.code) errorMsg += ` (Code: ${error.code})`;
                        console.error(errorMsg);
                    } else {
                        console.error(`   -> Error procesando ${currentUrl}: ${error.message}`);
                    }

                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            finalMarkdownContent = webMarkdownContent;
            console.log(`Total de URLs únicas visitadas o intentadas: ${visitedUrls.size}`);

        } catch (error) {
            console.error(`Error fatal durante el rastreo web: ${error.message}`);
        }
    }


    async function getGitignoreFilter(directoryPath) {
        const gitignorePath = path.join(directoryPath, '.gitignore');
        const ig = ignore();
        ig.add('.git');

        try {

            const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
            ig.add(gitignoreContent);
            console.log(`   -> .gitignore encontrado y cargado en ${directoryPath}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`   -> No se encontró .gitignore en ${directoryPath}. Usando solo regla para '.git'.`);
            } else {
                console.error(`   -> Error leyendo .gitignore en ${directoryPath}: ${error.message}`);
            }
        }
        return (relativePath) => ig.ignores(relativePath);
    }


    /**
     * Recorre recursivamente un directorio, construye el árbol y lee archivos.
     * @param {string} currentPath - Ruta absoluta actual.
     * @param {string} rootPath - Ruta raíz del proyecto (para calcular rutas relativas).
     * @param {function} isIgnored - Función que determina si una ruta relativa está ignorada.
     * @param {number} level - Nivel de profundidad actual.
     * @param {object} output - Objeto para acumular resultados { tree: string, files: [...] }.
     * @param {string} prefix - El prefijo de línea a usar para este nivel (ej: '|   ', '    ').
     */
    async function walkDir(currentPath, rootPath, isIgnored, level, output, prefix) {
        if (!currentPath || typeof currentPath !== 'string' || currentPath.trim() === '') {
            console.error(`[walkDir FATAL] Ruta actual inválida o vacía recibida. Path:`, currentPath);
            return;
        }

        try {

            const entries = await fs.readdir(currentPath, { withFileTypes: true });

            const validEntries = entries.filter(entry => {
                const entryName = entry.name;
                if (!entryName) return false;

                const entryPath = path.join(currentPath, entryName);
                const entryRelativePath = path.relative(rootPath, entryPath);
                const normalizedRelativePath = entryRelativePath.replace(/\\/g, '/');

                if (entryName.startsWith('.') && !config.includeDotFiles && entryName !== '.gitignore') return false;
                if (isIgnored(normalizedRelativePath)) return false;
                return true;
            });

            const filesToRead = [];

            for (let i = 0; i < validEntries.length; i++) {
                const entry = validEntries[i];
                const entryName = entry.name;
                const entryPath = path.join(currentPath, entryName);
                const entryRelativePath = path.relative(rootPath, entryPath);

                if (!entryPath || typeof entryPath !== 'string' || entryPath.trim() === '') {
                    console.error(`[walkDir FATAL Level ${level}] Ruta de entrada inválida calculada para "${entryName}" en "${currentPath}". Saltando.`);
                    continue;
                }

                const isLast = i === validEntries.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const nextPrefix = prefix + (isLast ? '    ' : '|   ');

                if (entry.isDirectory()) {
                    output.tree += prefix + connector + `**${entryName}/**` + '\n';
                    await walkDir(entryPath, rootPath, isIgnored, level + 1, output, nextPrefix);
                } else if (entry.isFile()) {
                    output.tree += prefix + connector + entryName + '\n';
                    if (!entryPath || typeof entryPath !== 'string' || entryPath.trim() === '') { /*...*/ }
                    else {
                        filesToRead.push({ filePath: entryPath, relativePath: entryRelativePath });
                    }
                }
            }

            const fileContents = await Promise.all(filesToRead.map(async (fileInfo) => {
                if (!fileInfo.filePath || typeof fileInfo.filePath !== 'string' || fileInfo.filePath.trim() === '') {
                    console.error(`[walkDir FATAL] Ruta de archivo inválida antes de leer:`, fileInfo.filePath);
                    return { path: fileInfo.relativePath || '[RUTA_INVALIDA]', content: `[Error: Ruta inválida (${fileInfo.filePath})]` };
                }

                const fileExtension = path.extname(fileInfo.filePath).toLowerCase();

                if (OMIT_CONTENT_EXTENSIONS.has(fileExtension)) {

                    return { path: fileInfo.relativePath, content: `[Contenido omitido (tipo de archivo: ${fileExtension})]` };
                }

                try {

                    const content = await fs.readFile(fileInfo.filePath, 'utf8');

                    const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
                    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE_BYTES) {
                        console.warn(`   -> Archivo demasiado grande: ${fileInfo.relativePath}. Contenido truncado.`);

                        return { path: fileInfo.relativePath, content: content.substring(0, MAX_FILE_SIZE_BYTES / 2) + '\n... [CONTENIDO TRUNCADO] ...' };
                    }
                    return { path: fileInfo.relativePath, content };
                } catch (readError) {
                    console.warn(`   -> No se pudo leer como UTF-8 (¿binario?): ${fileInfo.relativePath}. Error: ${readError.code}. Saltando contenido.`);
                    return { path: fileInfo.relativePath, content: `[Contenido no legible o binario: ${fileInfo.relativePath}]` };
                }
            }));
            output.files.push(...fileContents.filter(f => f && typeof f.path === 'string'));

        } catch (error) {
            console.error(`[walkDir ERROR Level ${level}] Error procesando directorio "${currentPath}": ${error.message}`);
            if (error.message && error.message.includes('path must not be empty')) {
                console.error(`[walkDir CRITICAL Level ${level}] El error "path must not be empty" ocurrió aquí. Path problemático: "${currentPath}"`);
            }
        }
    }

    async function processDirectory(directoryPath, isTemporary = false) {
        console.log(`Procesando directorio: ${directoryPath}`);
        let dirMarkdownContent = `# Estructura y Contenido del Directorio: ${path.basename(directoryPath)}\n\n`;

        try {

            const normalizedDirPath = path.normalize(directoryPath);
            const stats = await fs.stat(normalizedDirPath);
            if (!stats.isDirectory()) {
                throw new Error(`La ruta proporcionada no es un directorio: ${normalizedDirPath}`);
            }

            const isIgnored = await getGitignoreFilter(normalizedDirPath);

            const outputData = {
                tree: '## Árbol de Directorios\n\n```\n' + path.basename(normalizedDirPath) + '\n',
                files: []
            };


            await walkDir(normalizedDirPath, normalizedDirPath, isIgnored, 0, outputData, '');

            outputData.tree += '```\n';
            dirMarkdownContent += outputData.tree;
            dirMarkdownContent += '\n\n## Contenido de Archivos\n';

            outputData.files.sort((a, b) => a.path.localeCompare(b.path));

            for (const file of outputData.files) {
                const filePathString = (typeof file.path === 'string') ? file.path : '[RUTA INVÁLIDA]';
                const lang = getLanguage(filePathString);
                const displayPath = filePathString.replace(/\\/g, '/');
                dirMarkdownContent += `\n\n### Archivo: \`${displayPath}\`\n\n`;
                dirMarkdownContent += `\`\`\`${lang}\n`;
                dirMarkdownContent += (file.content || '[CONTENIDO VACÍO O INVÁLIDO]');
                dirMarkdownContent += '\n```\n';
                dirMarkdownContent += '\n---\n';
            }
            finalMarkdownContent = dirMarkdownContent;

        } catch (error) {
            console.error(`Error fatal procesando el directorio "${directoryPath}": ${error.message}`);
            if (error.message && error.message.includes('path must not be empty')) {
                console.error(`[processDirectory CRITICAL] El error "path must not be empty" ocurrió aquí. Path problemático: "${directoryPath}"`);
            }
        } finally {
            if (isTemporary) {
                console.log(`Limpiando directorio temporal: ${directoryPath}`);
                try {
                    await fs.rm(directoryPath, { recursive: true, force: true, maxRetries: 3 });
                    console.log(`   -> Directorio temporal eliminado.`);
                } catch (cleanupError) {
                    console.error(`   -> Error al eliminar directorio temporal ${directoryPath}: ${cleanupError.message}`);
                }
            }
        }
    }

    async function processRepo(repoUrl, branch) {
        let tempDir = '';
        try {
            const tempDirPrefix = path.join(os.tmpdir(), 'repo-crawler-');
            tempDir = await fs.mkdtemp(tempDirPrefix);
            console.log(`Directorio temporal creado: ${tempDir}`);

            let cloneCommand = `git clone --depth 1`;
            if (branch) {
                cloneCommand += ` --branch "${branch}"`;
            }
            cloneCommand += ` --quiet "${repoUrl}" "${tempDir}"`;

            const cloneResult = await executeCommand(cloneCommand);

            if (!cloneResult.success) {
                throw new Error(`Falló la clonación del repositorio desde ${repoUrl}. Verifica la URL y tus credenciales/permisos.`);
            }
            await processDirectory(tempDir, true);

        } catch (error) {
            console.error(`Error fatal en el procesamiento del repositorio ${repoUrl}: ${error.message}`);
            if (tempDir) {
                console.log(`Intentando limpiar directorio temporal tras error: ${tempDir}`);
                try {
                    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
                    console.log(`   -> Directorio temporal eliminado tras error.`);
                } catch (cleanupError) {
                    console.error(`   -> Error al eliminar directorio temporal ${tempDir} tras error: ${cleanupError.message}`);
                }
            }
        }
    }

    async function main() {
        console.log('Iniciando Smart Crawler...');
        const mode = argv.url ? 'Web Crawler' : (argv.repo ? 'Repo Processor' : 'Directory Processor');
        console.log('Modo:', mode);
        console.log('Archivo de salida:', config.outputFile);

        try {
            await fs.writeFile(config.outputFile, '', 'utf-8');
            console.log(`Archivo de salida anterior (${config.outputFile}) limpiado.`);
        } catch (err) {
            console.warn(`Advertencia: No se pudo limpiar el archivo de salida anterior (${config.outputFile}): ${err.message}`);
        }

        if (argv.url) {
            await crawlWeb(argv.url, config.maxDepth);
        } else if (argv.repo) {
            await processRepo(argv.repo, config.branch);
        } else if (argv.dir) {
            const dirPath = path.resolve(argv.dir);
            await processDirectory(dirPath, false);
        } else {
            console.error("Error interno: No se detectó modo de operación válido.");
            process.exitCode = 1;
        }

        if (process.exitCode !== 1 && finalMarkdownContent.trim().length > 0) {
            await writeOutput(finalMarkdownContent, config.outputFile);
        } else if (process.exitCode !== 1) {
            console.log("\nProceso completado, pero no se generó contenido Markdown para guardar.");
        } else {
            console.log("\nProceso finalizado con errores.");
        }

        console.log('Smart Crawler finalizado.');
    }

    main().catch(error => {
        console.error("\nError inesperado no capturado en la ejecución principal:", error);
        process.exitCode = 1;
    }).finally(() => {
        if (process.exitCode && process.exitCode !== 0) {
            process.exit(process.exitCode);
        }
    });