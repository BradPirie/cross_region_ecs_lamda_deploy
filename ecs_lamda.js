exports.handler = function (event, context, callback) {
    let aws = require("aws-sdk");
    aws.config.update({ region: "af-south-1" });

    let ecs = new aws.ECS();
    let codepipeline = new aws.CodePipeline();
    let jobId = event["CodePipeline.job"].id;

    const userParameters = JSON.parse(
        event["CodePipeline.job"]
            .data
            .actionConfiguration
            .configuration
            .UserParameters);

    let taskDefinition = userParameters.TASK_DEFINITION;
    let serviceName = userParameters.SERVICE_NAME;
    let clusterName = userParameters.CLUSTER_NAME;

    console.log("Task Definition: %s", taskDefinition);
    console.log("Service Name: %s", serviceName);
    console.log("Cluster Name: %s", clusterName);

    // DESCRIBE CURRENT TASK
    console.log("Creating new Task: %s", taskDefinition);
    ecs.describeTaskDefinition( { taskDefinition: taskDefinition },
        function (err, data) {
          if (err) {
            console.log(err, err.stack);
            putJobFailure(err.stack);
          } else {
            console.log("Successfully fetched latest task definition");

            // REMOVING NON REQUIRED JSON FIELDS
            delete data.taskDefinition["revision"];
            delete data.taskDefinition["taskDefinitionArn"];
            delete data.taskDefinition["status"];
            delete data.taskDefinition["requiresAttributes"];
            delete data.taskDefinition["registeredBy"];
            delete data.taskDefinition["registeredAt"];
            delete data.taskDefinition["compatibilities"];

            // REGISTER NEW TASK
            ecs.registerTaskDefinition(data.taskDefinition, function (err, data) {
              if (err) {
                console.log(err, err.stack);
                putJobFailure(err.stack);
              } else {
                let newTaskDefinition = taskDefinition + ":" + data.taskDefinition.revision;
                let oldTaskDefinition = taskDefinition + ":" + (data.taskDefinition.revision - 1);

                console.log("Successfully registered new task definition: %s",  newTaskDefinition);

                // UPDATING SERVICE
                let params = {
                    service: serviceName,
                        cluster: clusterName,
                  taskDefinition: newTaskDefinition,
                    desiredCount: 1,
                };
                ecs.updateService(params, function (err, data) {
                  if (err) {
                    console.log(err, err.stack);
                  } else {
                    console.log("Successfully updated service: %s", serviceName);
                  }
                });

                // DEREGISTER OLD TASK
                params = {
                  taskDefinition: oldTaskDefinition,
                };
                ecs.deregisterTaskDefinition(params, function (err, data) {
                  if (err) {
                    console.log(err, err.stack);
                    putJobFailure(err.stack);
                  } else {
                    let successMessage =
                        "Successfully deregistered previous task definition: " +
                        oldTaskDefinition;
                    console.log(successMessage);
                    putJobSuccess(successMessage);
                  }
                });
              }
            });
          }
        }
    );

    // Notify CodePipeline of a failed job
    let putJobFailure = function (message) {
      aws.config.update({ region: "eu-west-1" });
      codepipeline = new aws.CodePipeline();
      let params = {
        jobId: jobId,
        failureDetails: {
          message: JSON.stringify(message),
          type: "JobFailed",
          externalExecutionId: context.awsRequestId,
        },
      };
      codepipeline.putJobFailureResult(params, function (err, data) {
        context.fail(message);
      });
    };

    // Notify CodePipeline of a successful job
    let putJobSuccess = function (message) {
      aws.config.update({ region: "eu-west-1" });
      codepipeline = new aws.CodePipeline();
      let params = {
        jobId: jobId,
      };
      codepipeline.putJobSuccessResult(params, function (err, data) {
        if (err) {
          context.fail(err);
        } else {
          context.succeed(message);
        }
      });
    };
};