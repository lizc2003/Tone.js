rm -f tone.tgz
mkdir -p package
cp -r build package/
cp package.json package/
cp README.md package/
tar zcvf tone.tgz package
rm -fr package
