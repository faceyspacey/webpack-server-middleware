'use strict';

const debug = require('debug')('webpack-hot-server-middleware');
const path = require('path');
const requireFromString = require('require-from-string');
const MultiCompiler = require('webpack/lib/MultiCompiler');
const sourceMapSupport = require('source-map-support');

const DEFAULTS = {
    chunkName: 'main'
};

function interopRequireDefault(obj) {
    return obj && obj.__esModule ? obj.default : obj;
}

function findCompiler(multiCompiler, name) {
    return multiCompiler.compilers.find(compiler => compiler.name === name);
}

function findStats(multiStats, name) {
    return multiStats.stats.find(stats => stats.compilation.name === name);
}

function getFilename(serverStats, outputPath, chunkName) {
    const assetsByChunkName = serverStats.toJson().assetsByChunkName;
    let filename = assetsByChunkName[chunkName] || '';
    // If source maps are generated `assetsByChunkName.main`
    // will be an array of filenames.
    return path.join(
        outputPath,
        Array.isArray(filename) ?
            filename.find(asset => /\.js$/.test(asset)) : filename
    );
}

function getServerRenderer(filename, buffer, clientStats, serverStats, options) {
    const errMessage = `The 'server' compiler must export a function in the form of \`(stats) => (req, res, next) => void 0\``;

    let serverRenderer = interopRequireDefault(
        requireFromString(buffer.toString(), filename)
    );
    if (typeof serverRenderer !== 'function') {
        throw new Error(errMessage);
    }

    serverRenderer = serverRenderer(clientStats.toJson(), serverStats.toJson(), options);
    if (typeof serverRenderer !== 'function') {
        throw new Error(errMessage);
    }

    return serverRenderer;
}

function installSourceMapSupport(fs) {
    sourceMapSupport.install({
        // NOTE: If https://github.com/evanw/node-source-map-support/pull/149
        // lands we can be less aggressive and explicitly invalidate the source
        // map cache when Webpack recompiles.
        emptyCacheBetweenOperations: true,
        retrieveFile(source) {
            try {
                return fs.readFileSync(source, 'utf8');
            } catch(ex) {
                // Doesn't exist
            }
        }
    });
}

/**
 * Passes the request to the most up to date 'server' bundle.
 * NOTE: This must be mounted after webpackDevMiddleware to ensure this
 * middleware doesn't get called until the compilation is complete.
 * @param   {MultiCompiler} multiCompiler      e.g webpack([clientConfig, serverConfig])
 * @options {String}        options.chunkName  The name of the main server chunk.
 * @return  {Function}                         Middleware fn.
 */
function webpackHotServerMiddleware(multiCompiler, options) {
    debug('Using webpack-hot-server-middleware');

    options = Object.assign({}, DEFAULTS, options);

    if (!(multiCompiler instanceof MultiCompiler)) {
        throw new Error(`Expected webpack compiler to contain both a 'client' and 'server' config`);
    }

    const serverCompiler = findCompiler(multiCompiler, 'server');
    const clientCompiler = findCompiler(multiCompiler, 'client');

    if (!serverCompiler) {
        throw new Error(`Expected a webpack compiler named 'server'`);
    }
    if (!clientCompiler) {
        throw new Error(`Expected a webpack compiler named 'client'`);
    }

    const outputFs = serverCompiler.outputFileSystem;
    const outputPath = serverCompiler.outputPath;

    installSourceMapSupport(outputFs);

    let serverRenderer;
    let error = false;

    multiCompiler.plugin('done', multiStats => {
        error = false;
        const clientStats = findStats(multiStats, 'client');
        const serverStats = findStats(multiStats, 'server');
        // Server compilation errors need to be propagated to the client.
        if (serverStats.compilation.errors.length) {
            error = serverStats.compilation.errors[0];
            return;
        }
        const filename = getFilename(serverStats, outputPath, options.chunkName);
        const buffer = outputFs.readFileSync(filename);
        options.config = {
            client: clientCompiler.options,
            server: serverCompiler.options
        }
        
        try {
            serverRenderer = getServerRenderer(filename, buffer, clientStats, serverStats, options);
        } catch (ex) {
            debug(ex);
            error = ex;
        }
    });

    return (req, res, next) => {
        debug(`Receive request ${req.url}`);
        if (error) {
            return next(error);
        }
        serverRenderer(req, res, next);
    };
}

module.exports = webpackHotServerMiddleware;
