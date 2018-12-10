#!/usr/bin/env node

const startTime = Date.now()
const cluster = require('cluster')
const child_process = require('child_process')
const workers = []

// Globals
global.totalSequences = 0
global.iterationBlock = 2000
global.totalIterations = 0
global.lastUniqueTime = Date.now()
global.db = require('better-sqlite3')('smiles.sqlite')

// add exit hook for closing db
const exitHook = require('exit-hook')
exitHook(() => {
	db.close()
})

// time out if no new sequences found in 1 minute
const TIMEOUT = 60 * 1000
var noNewFoundTime = 0

// Setup config vars from arguments
const { numOfSequences, linearMaximum, bar, method, maximum, props,
	sequenceType, METHOD_SEQUENTIAL, TYPE_CYCLIC, METHOD_RANDOM } = require('./utils/generate/config')


// Master setup
var dbWorker
if(cluster.isMaster) {

	bar.update(0)

	db.prepare(
		`CREATE TABLE IF NOT EXISTS smiles(
			id INTEGER PRIMARY KEY,
			name TEXT UNIQUE,
			smiles TEXT,
			score DOUBLE,
			miLogP DOUBLE,
			TPSA DOUBLE,
			natoms DOUBLE,
			MW DOUBLE,
			nON DOUBLE,
			nOHNH DOUBLE,
			nrotb DOUBLE,
			volume DOUBLE
		)`).run()
	db.prepare(
		`CREATE TABLE IF NOT EXISTS history(
			id INTEGER PRIMARY KEY CHECK (id = 0),
			last_gen INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`).run()
	db.prepare(`INSERT OR IGNORE INTO history VALUES (0, CURRENT_TIMESTAMP)`).run()
	db.prepare(`UPDATE history SET last_gen = CURRENT_TIMESTAMP`).run()


	var w, worker, data = []
	const WRITE_BLOCK = Math.max(1000, Math.min(20000, numOfSequences/10))
	const workerListener = function(message) {
		totalIterations += message.iterations
		masterCheckForExit()

		if(message.sequences){
			totalSequences += message.sequences
			lastUniqueTime = Date.now()
			bar.update(totalSequences/numOfSequences)
		} else
			noNewFoundTime = Date.now() - lastUniqueTime

		if(message.data){
			data = data.concat(message.data)
			if(data.length >= WRITE_BLOCK || data.length + totalSequences >= numOfSequences){
				dbWorker.send({data})
				message.data = null
				data = []
			}
		}

		// update all workers
		for (w in workers) {
			workers[w].send({ totalIterations, totalSequences });
		}
	}

	const numCPUs = require('os').cpus().length
	for (let i = 0; i < numCPUs-2; i++) {
		var worker = cluster.fork()
		worker.on('message', workerListener)
		workers.push(worker)
	}

	dbWorker = child_process.fork('./utils/db')
	dbWorker.on('message', function(message){
		if(message.newSequences) totalSequences += message.newSequences
		if(totalSequences < numOfSequences) bar.update(totalSequences/numOfSequences)
	})
}

function keepRunning(){
	return totalSequences < numOfSequences &&
		((method == METHOD_RANDOM && noNewFoundTime < TIMEOUT) ||
		totalIterations < linearMaximum)
}

var exited
function masterCheckForExit(){
	if(!cluster.isMaster) return
	if(keepRunning()) return
	if(exited) return

	dbWorker.send({exit: true})
	for(var w in workers){
		workers[w].send({exit: true})
	}

	exited = true

	if(bar.curr != bar.total) bar.update(1)

	if(method == METHOD_RANDOM && noNewFoundTime >= TIMEOUT) console.log(`\nDidnt find any unique sequences for ${TIMEOUT/1000} seconds, terminating`)

	console.log(`\nComplete! Generated ${totalSequences} unique sequences in ${totalIterations} iterations\n`)

	const endTime = Date.now()
	const duration = (endTime - startTime)/1000
	const used = process.memoryUsage().rss / 1024 / 1024
	console.log(`The script took ${duration}s and used approximately ${Math.round(used * 100) / 100} MB memory`)
}

// Child Process
if(!cluster.isMaster)
{
	// when child recieves messages from master
	process.on('message', function(message) {
		if(message.exit) process.exit()
		if(message.totalSequences) totalSequences = message.totalSequences
		if(message.totalIterations) totalIterations = message.totalIterations
		if(message.lastUniqueTime) lastUniqueTime = message.lastUniqueTime
	})

	// pull in generation functions
	const generateRandom = require('./utils/generate/random')
	const generateLinear = require('./utils/generate/linear')
	const generateCyclic = require('./utils/generate/cyclic')
	// const generateCyclicRecursive = require('./utils/generate/recursive')

	// choose which function to use
	const generate = method == METHOD_SEQUENTIAL ?
		(sequenceType == TYPE_CYCLIC ? generateCyclic : generateLinear) :
		generateRandom


	// Start the main loop
	let iterationInterval = setInterval(function(){

		noNewFoundTime = Date.now() - lastUniqueTime

		if(keepRunning()){
			generate()
			// global.gc()
			// console.log('Random Gen Mem: ',
			// 	process.memoryUsage().rss/1024/1024
			// )
		}
		else
			clearInterval(iterationInterval)
	}, 0)
}
