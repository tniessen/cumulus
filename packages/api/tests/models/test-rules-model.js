'use strict';

const test = require('ava');
const sinon = require('sinon');
const cloneDeep = require('lodash.clonedeep');

const aws = require('@cumulus/common/aws');
const { randomString, randomId } = require('@cumulus/common/test-utils');
const models = require('../../models');
const { fakeRuleFactoryV2 } = require('../../lib/testUtils');

process.env.RulesTable = `RulesTable_${randomString()}`;
process.env.stackName = randomString();
process.env.messageConsumer = randomString();
process.env.KinesisInboundEventLogger = randomString();
process.env.system_bucket = randomString();

const workflow = randomString();
const workflowfile = `${process.env.stackName}/workflows/${workflow}.json`;

async function getKinesisEventMappings() {
  const eventLambdas = [process.env.messageConsumer, process.env.KinesisInboundEventLogger];

  const mappingPromises = eventLambdas.map((lambda) => {
    const mappingParms = { FunctionName: lambda };
    return aws.lambda().listEventSourceMappings(mappingParms).promise();
  });
  return Promise.all(mappingPromises);
}

let rulesModel;

test.before(async () => {
  // create Rules table
  rulesModel = new models.Rule();
  await rulesModel.createTable();
  await aws.s3().createBucket({ Bucket: process.env.system_bucket }).promise();
  await aws.s3().putObject({
    Bucket: process.env.system_bucket,
    Key: workflowfile,
    Body: 'test data'
  }).promise();
});

test.beforeEach(async (t) => {
  t.context.onetimeRule = {
    name: randomString(),
    workflow,
    provider: 'my-provider',
    collection: {
      name: 'my-collection-name',
      version: 'my-collection-version'
    },
    rule: {
      type: 'onetime'
    },
    state: 'ENABLED'
  };

  t.context.kinesisRule = {
    name: randomString(),
    workflow,
    provider: 'my-provider',
    collection: {
      name: 'my-collection-name',
      version: 'my-collection-version'
    },
    rule: {
      type: 'kinesis',
      value: 'my-kinesis-arn'
    },
    state: 'ENABLED'
  };
});

test.after.always(async () => {
  // cleanup table
  await rulesModel.deleteTable();
  await aws.recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test('create defaults rule state to ENABLED', async (t) => {
  const { onetimeRule } = t.context;

  // remove state from rule to be created
  delete onetimeRule.state;

  // create rule
  const rule = await rulesModel.create(onetimeRule);

  t.is(rule.state, 'ENABLED');

  // delete rule
  await rulesModel.delete(rule);
});

test('create and delete a onetime rule', async (t) => {
  const { onetimeRule } = t.context;

  // create rule
  const rule = await rulesModel.create(onetimeRule);

  t.is(rule.name, onetimeRule.name);

  // delete rule
  await rulesModel.delete(rule);
  t.false(await rulesModel.exists({ name: rule.name }));
});

test('enabling a disabled rule updates the state', async (t) => {
  const { onetimeRule } = t.context;

  const ruleItem = cloneDeep(onetimeRule);
  ruleItem.state = 'DISABLED';

  const rule = await rulesModel.create(ruleItem);

  t.is(rule.state, 'DISABLED');

  const updates = { name: rule.name, state: 'ENABLED' };
  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.name, rule.name);
  t.is(updatedRule.type, rule.type);
  t.is(updatedRule.state, 'ENABLED');

  await rulesModel.delete(rule);
});

test.serial('create a kinesis type rule adds event mappings, creates rule', async (t) => {
  const { kinesisRule } = t.context;

  // create rule
  const createdRule = await rulesModel.create(kinesisRule);
  const kinesisEventMappings = await getKinesisEventMappings();
  const consumerEventMappings = kinesisEventMappings[0].EventSourceMappings;
  const logEventMappings = kinesisEventMappings[1].EventSourceMappings;

  t.is(consumerEventMappings.length, 1);
  t.is(logEventMappings.length, 1);
  t.is(consumerEventMappings[0].UUID, createdRule.rule.arn);
  t.is(logEventMappings[0].UUID, createdRule.rule.logEventArn);

  t.is(createdRule.name, kinesisRule.name);
  t.is(createdRule.rule.value, kinesisRule.rule.value);
  t.false(createdRule.rule.arn === undefined);
  t.false(createdRule.rule.logEventArn === undefined);

  // clean up
  await rulesModel.delete(createdRule);
});

test.serial('deleting a kinesis style rule removes event mappings', async (t) => {
  const { kinesisRule } = t.context;

  // create and delete rule
  const createdRule = await rulesModel.create(kinesisRule);
  t.true(await rulesModel.exists({ name: createdRule.name }));

  await rulesModel.delete(createdRule);

  const kinesisEventMappings = await getKinesisEventMappings();
  const consumerEventMappings = kinesisEventMappings[0].EventSourceMappings;
  const logEventMappings = kinesisEventMappings[1].EventSourceMappings;

  t.is(consumerEventMappings.length, 0);
  t.is(logEventMappings.length, 0);
});

test.serial('update a kinesis type rule state, event source mappings do not change', async (t) => {
  const { kinesisRule } = t.context;

  // create rule
  await rulesModel.create(kinesisRule);
  const rule = await rulesModel.get({ name: kinesisRule.name });

  // update rule state
  const updates = { name: rule.name, state: 'ENABLED' };
  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.state, 'ENABLED');

  // Event source mapping references don't change
  t.is(updatedRule.rule.arn, rule.rule.arn);
  t.is(updatedRule.rule.logEventArn, rule.rule.logEventArn);

  // clean up
  await rulesModel.delete(rule);
});

test.serial('update a kinesis type rule value, resulting in new event source mappings', async (t) => {
  const { kinesisRule } = t.context;

  // create rule
  await rulesModel.create(kinesisRule);
  const rule = await rulesModel.get({ name: kinesisRule.name });

  // update rule value
  const updates = {
    name: rule.name,
    rule: { type: rule.rule.type, value: 'my-new-kinesis-arn' }
  };

  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.name, rule.name);
  t.not(updatedRule.rule.value, rule.rule.value);

  // Event source mappings exist and have been updated
  t.truthy(updatedRule.rule.arn);
  t.not(updatedRule.rule.arn, rule.rule.arn);
  t.truthy(updatedRule.rule.logEventArn);
  t.not(updatedRule.rule.logEventArn, rule.rule.logEventArn);

  await rulesModel.delete(rule);
});

test.serial('update a kinesis type rule workflow does not affect value or event source mappings', async (t) => {
  const { kinesisRule } = t.context;

  // create rule
  await rulesModel.create(kinesisRule);
  const rule = await rulesModel.get({ name: kinesisRule.name });

  // update rule value
  const updates = {
    name: rule.name,
    workflow: 'new-workflow'
  };

  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.name, rule.name);
  t.is(updatedRule.rule.value, rule.rule.value);

  // Event source mappings exist and have been updated
  t.truthy(updatedRule.rule.arn);
  t.is(updatedRule.rule.arn, rule.rule.arn);
  t.truthy(updatedRule.rule.logEventArn);
  t.is(updatedRule.rule.logEventArn, rule.rule.logEventArn);

  await rulesModel.delete(rule);
});

test.serial('create a kinesis type rule, using existing event source mappings', async (t) => {
  const { kinesisRule } = t.context;

  // create two rules with same value
  const newKinesisRule = cloneDeep(kinesisRule);
  newKinesisRule.name = `${kinesisRule.name}_new`;

  await rulesModel.create(kinesisRule);
  const rule = await rulesModel.get({ name: kinesisRule.name });

  await rulesModel.create(newKinesisRule);
  const newRule = await rulesModel.get({ name: newKinesisRule.name });

  t.not(newRule.name, rule.name);
  t.is(newRule.rule.value, rule.rule.value);
  t.false(newRule.rule.arn === undefined);
  t.false(newRule.rule.logEventArn === undefined);
  // Event source mappings have not changed
  t.is(newRule.rule.arn, rule.rule.arn);
  t.is(newRule.rule.logEventArn, rule.rule.logEventArn);

  await rulesModel.delete(rule);
  await rulesModel.delete(newRule);
});

test.serial('it does not delete event source mappings if they exist for other rules', async (t) => {
  const { kinesisRule } = t.context;

  // we have three rules to create
  const kinesisRuleTwo = cloneDeep(kinesisRule);
  kinesisRuleTwo.name = `${kinesisRule.name}_two`;

  const kinesisRuleThree = cloneDeep(kinesisRule);
  kinesisRuleThree.name = `${kinesisRule.name}_three`;

  // create two rules with same value
  await rulesModel.create(kinesisRule);
  const rule = await rulesModel.get({ name: kinesisRule.name });
  await rulesModel.create(kinesisRuleTwo);
  const ruleTwo = await rulesModel.get({ name: kinesisRuleTwo.name });

  // same event source mapping
  t.is(ruleTwo.rule.arn, rule.rule.arn);
  t.is(ruleTwo.rule.logEventArn, rule.rule.logEventArn);

  // delete the second rule, it should not delete the event source mapping
  await rulesModel.delete(ruleTwo);

  // create third rule, it should use the existing event source mapping
  await rulesModel.create(kinesisRuleThree);
  const ruleThree = await rulesModel.get({ name: kinesisRuleThree.name });
  t.is(ruleThree.rule.arn, rule.rule.arn);
  t.is(ruleThree.rule.logEventArn, rule.rule.logEventArn);

  // Cleanup -- this is required for repeated local testing, else localstack retains rules
  await rulesModel.delete(rule);
  await rulesModel.delete(ruleThree);
});

test.serial('Creating a kinesis rule where an event source mapping already exists, but is not enabled, succeeds', async (t) => {
  process.env.messageConsumer = randomString();

  const item = fakeRuleFactoryV2({
    workflow,
    rule: {
      type: 'kinesis',
      value: randomString()
    },
    state: 'ENABLED'
  });

  const lambdaStub = sinon.stub(aws, 'lambda')
    .returns({
      createEventSourceMapping: () => ({
        promise: () => Promise.resolve({ UUID: randomString() })
      }),
      deleteEventSourceMapping: () => ({
        promise: () => Promise.resolve()
      }),
      updateEventSourceMapping: () => ({
        promise: () => Promise.resolve({ UUID: randomString() })
      }),
      listEventSourceMappings: () => ({
        promise: () => Promise.resolve({
          EventSourceMappings: [
            {
              UUID: randomString(),
              EventSourceArn: item.rule.value,
              FunctionArn: `arn:aws:lambda:us-west-2:000000000000:function:${process.env.messageConsumer}`,
              State: 'Disabled'
            }
          ]
        })
      })
    });

  try {
    await rulesModel.create(item);
    t.pass();
  } catch (err) {
    t.fail(err);
  } finally {
    lambdaStub.restore();
  }
});

test('Creating a rule with a queueName parameter', async (t) => {
  const { onetimeRule } = t.context;

  const ruleItem = cloneDeep(onetimeRule);
  ruleItem.queueName = 'testQueue';

  const response = await rulesModel.create(ruleItem);

  const payload = await models.Rule.buildPayload(ruleItem);

  t.truthy(response.queueName);
  t.is(response.queueName, ruleItem.queueName);
  t.is(payload.queueName, ruleItem.queueName);
});

test('creating a disabled SNS rule creates no event source mapping', async (t) => {
  const snsTopicArn = randomString();
  const item = fakeRuleFactoryV2({
    workflow,
    rule: {
      type: 'sns',
      value: snsTopicArn
    },
    state: 'DISABLED'
  });

  const rule = await rulesModel.create(item);

  t.is(rule.state, 'DISABLED');
  t.is(rule.rule.value, snsTopicArn);
  t.falsy(rule.rule.arn);
});

test.serial('disabling an SNS rule removes the event source mapping', async (t) => {
  const snsTopicArn = randomString();
  const snsStub = sinon.stub(aws, 'sns')
    .returns({
      listSubscriptionsByTopic: () => ({
        promise: () => Promise.resolve({
          Subscriptions: [{
            Endpoint: process.env.messageConsumer,
            SubscriptionArn: snsTopicArn
          }]
        })
      }),
      unsubscribe: () => ({
        promise: () => Promise.resolve()
      })
    });
  const lambdaStub = sinon.stub(aws, 'lambda')
    .returns({
      addPermission: () => ({
        promise: () => Promise.resolve()
      }),
      removePermission: () => ({
        promise: () => Promise.resolve()
      })
    });

  const item = fakeRuleFactoryV2({
    workflow,
    rule: {
      type: 'sns',
      value: snsTopicArn
    },
    state: 'ENABLED'
  });

  const rule = await rulesModel.create(item);

  t.is(rule.rule.value, snsTopicArn);
  t.is(rule.state, 'ENABLED');

  const updates = { name: rule.name, state: 'DISABLED' };
  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.name, rule.name);
  t.is(updatedRule.state, 'DISABLED');
  t.is(updatedRule.rule.type, rule.rule.type);
  t.is(updatedRule.rule.value, rule.rule.value);
  t.falsy(updatedRule.rule.arn);

  await rulesModel.delete(rule);
  snsStub.restore();
  lambdaStub.restore();
});

test.serial('updating an SNS rule updates the event source mapping', async (t) => {
  const snsTopicArn = randomString();
  const newSnsTopicArn = randomString();

  const snsStub = sinon.stub(aws, 'sns')
    .returns({
      listSubscriptionsByTopic: () => ({
        promise: () => Promise.resolve({
          Subscriptions: [{
            Endpoint: process.env.messageConsumer,
            SubscriptionArn: randomString()
          }]
        })
      }),
      unsubscribe: () => ({
        promise: () => Promise.resolve()
      })
    });
  const lambdaStub = sinon.stub(aws, 'lambda')
    .returns({
      addPermission: () => ({
        promise: () => Promise.resolve()
      }),
      removePermission: () => ({
        promise: () => Promise.resolve()
      })
    });

  const item = fakeRuleFactoryV2({
    workflow,
    rule: {
      type: 'sns',
      value: snsTopicArn
    },
    state: 'ENABLED'
  });

  const rule = await rulesModel.create(item);

  t.is(rule.rule.value, snsTopicArn);

  const updates = { name: rule.name, rule: { value: newSnsTopicArn } };
  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.name, rule.name);
  t.is(updatedRule.type, rule.type);
  t.is(updatedRule.rule.value, newSnsTopicArn);
  t.not(updatedRule.rule.arn, rule.rule.arn);

  await rulesModel.delete(rule);
  snsStub.restore();
  lambdaStub.restore();
});

test.serial('deleting an SNS rule updates the event source mapping', async (t) => {
  const snsTopicArn = randomString();

  const snsStub = sinon.stub(aws, 'sns')
    .returns({
      listSubscriptionsByTopic: () => ({
        promise: () => Promise.resolve({
          Subscriptions: [{
            Endpoint: process.env.messageConsumer,
            SubscriptionArn: randomString()
          }]
        })
      }),
      unsubscribe: () => ({
        promise: () => Promise.resolve()
      })
    });
  const lambdaStub = sinon.stub(aws, 'lambda')
    .returns({
      addPermission: () => ({
        promise: () => Promise.resolve()
      }),
      removePermission: () => ({
        promise: () => Promise.resolve()
      })
    });
  const unsubscribeSpy = sinon.spy(aws.sns(), 'unsubscribe');

  const item = fakeRuleFactoryV2({
    workflow,
    rule: {
      type: 'sns',
      value: snsTopicArn
    },
    state: 'ENABLED'
  });

  const rule = await rulesModel.create(item);

  t.is(rule.rule.value, snsTopicArn);

  await rulesModel.delete(rule);

  t.true(unsubscribeSpy.called);
  t.true(unsubscribeSpy.calledWith({
    SubscriptionArn: rule.rule.arn
  }));

  snsStub.restore();
  lambdaStub.restore();
});

test('updates rule meta object', async (t) => {
  const { onetimeRule } = t.context;

  const triggerRule = randomId('triggerRule');
  const ruleItem = cloneDeep(onetimeRule);
  ruleItem.meta = {
    triggerRule
  };

  const rule = await rulesModel.create(ruleItem);

  t.is(rule.meta.triggerRule, triggerRule);

  const newTriggerRule = randomId('triggerRule');
  const updates = { name: rule.name, meta: { triggerRule: newTriggerRule } };
  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.meta.triggerRule, newTriggerRule);
});

test('updates a deeply nested key', async (t) => {
  const { onetimeRule } = t.context;

  const testObject = {
    key: randomString()
  };
  const ruleItem = cloneDeep(onetimeRule);
  ruleItem.meta = {
    testObject
  };

  const rule = await rulesModel.create(ruleItem);

  t.deepEqual(rule.meta.testObject, testObject);

  const newTestObject = Object.assign({}, testObject, {
    key: randomString()
  });
  const updates = {
    name: rule.name,
    meta: {
      testObject: newTestObject
    }
  };
  const updatedRule = await rulesModel.update(rule, updates);

  t.deepEqual(updatedRule.meta.testObject, newTestObject);
});

test('update preserves nested keys', async (t) => {
  const { onetimeRule } = t.context;

  const testObject = {
    key: randomString()
  };
  const ruleItem = cloneDeep(onetimeRule);
  ruleItem.meta = {
    foo: 'bar',
    testObject
  };

  const rule = await rulesModel.create(ruleItem);

  t.is(rule.meta.foo, 'bar');
  t.deepEqual(rule.meta.testObject, testObject);

  const newTestObject = Object.assign({}, testObject, {
    key: randomString()
  });
  const updates = {
    name: rule.name,
    meta: {
      testObject: newTestObject
    }
  };
  const updatedRule = await rulesModel.update(rule, updates);

  t.is(updatedRule.meta.foo, 'bar');
  t.deepEqual(updatedRule.meta.testObject, newTestObject);
});