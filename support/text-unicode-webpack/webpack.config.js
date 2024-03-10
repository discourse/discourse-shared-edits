const path = require('path');

module.exports = {
  entry: './src/index.js',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, '..', '..', 'public', 'javascripts'),
    filename: 'text-unicode-dist.js',
    library: 'otLib',
    libraryTarget: 'umd'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        use: [{ loader: 'babel-loader'}]
      }
    ]
  }
};
